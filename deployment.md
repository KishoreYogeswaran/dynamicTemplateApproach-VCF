# Video Content Factory — API Service & Deployment Plan

## Overview

The Video Content Factory (VCF) pipeline converts storyboard JSON into fully rendered educational videos. This document covers the API service architecture, deployment strategy on GCP, and scaling considerations.

**Workload profile:** CPU/RAM intensive, long-running (2-10 min per pipeline), parallel requests from multiple Python pipelines.

---

## API Architecture

### Endpoints

```
POST /api/jobs                    Full pipeline run
POST /api/jobs/regenerate-scene   Single scene regen + re-stitch
GET  /api/jobs/:jobId             Poll job status
GET  /api/jobs/:jobId/video       Download final MP4
GET  /health                      Queue depth, active workers, memory usage
```

### Full Pipeline

```
POST /api/jobs
Content-Type: application/json

{
  "storyboard": { ... },              // Inline storyboard JSON
  "options": {
    "concurrency": 3,                 // Parallel scenes within this job
    "fps": 24,
    "gapMs": 700,
    "themeOverride": null
  }
}

Response: { "jobId": "abc123", "status": "queued" }
```

### Scene Regeneration

Regenerates a single scene (LLM HTML + record) and re-stitches the final video using all existing scene MP4s + the newly generated one.

```
POST /api/jobs/regenerate-scene
Content-Type: application/json

{
  "module": 2,
  "lesson": 3,
  "ml": 3,
  "language": "en",
  "scenes": ["SC3"],              // Single or multiple: ["SC3", "SC7", "SC12"]
  "skipTTS": true,
  "skipAvatar": true
}

Response: { "jobId": "def456", "status": "queued" }
```

Internal flow:
1. Run pipeline for each scene in the `scenes` array (with specified skip flags)
2. Re-stitch ALL scene MP4s in the output folder (existing + newly generated ones)
3. Return updated `M2_L3_ML3_Complete_en.mp4`

### Poll Status

```
GET /api/jobs/:jobId

Response:
{
  "jobId": "abc123",
  "status": "active",           // queued | active | completed | failed
  "progress": "Recording SC5",  // Human-readable progress
  "createdAt": "2026-03-25T10:00:00Z",
  "result": null                // On completion: { videoPath, fileName }
}
```

### Download Video

```
GET /api/jobs/:jobId/video

Response: MP4 binary stream
Content-Type: video/mp4
Content-Disposition: attachment; filename="M2_L3_ML3_Complete_en.mp4"
```

---

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| HTTP Server | Fastify | Async-first, schema validation, lightweight |
| Job Queue | BullMQ | Redis-backed, concurrency control, retries, persistence |
| Redis | Redis 7 (Memorystore or self-hosted) | Job persistence, survives restarts |
| Process Manager | PM2 or systemd | Auto-restart, log management |
| Reverse Proxy | nginx | SSL termination, request buffering |

### Packages to Install

```
fastify              HTTP framework
bullmq               Redis-backed job queue
ioredis              Redis client (BullMQ peer dep)
@fastify/cors        CORS for cross-origin Python clients
uuid                 Unique job IDs
```

---

## File Structure

```
src/
  server/
    index.js                 Fastify app setup, starts server
    config.js                Port, Redis URL, concurrency from env
    routes/
      jobs.js                POST/GET /api/jobs endpoints
      health.js              GET /health
    queue/
      job-store.js           BullMQ queue + worker setup
      processors/
        full-pipeline.js     Worker: calls runPipeline()
        regen-scene.js       Worker: single scene + re-stitch
scripts/
  start-server.js            Entry point: loads env, starts server
```

---

## Job Queue Design

### Concurrency Model

```
Python Pipeline A ──POST──┐
Python Pipeline B ──POST──┤──→ Redis Queue ──→ Worker Pool (N concurrent)
Python Pipeline C ──POST──┘         │
                                    ├── Worker 1: runPipeline(ML3)
                                    ├── Worker 2: runPipeline(ML5)
                                    └── Worker 3: idle (waiting)
```

- **Queue concurrency** = max simultaneous pipeline runs (configurable via `MAX_CONCURRENT_JOBS`)
- **Scene concurrency** = parallel scenes within one pipeline (existing `--concurrency` flag, default 3)
- Total Chromium instances = queue concurrency x scene concurrency

**Example: 10 parallel API requests with `MAX_CONCURRENT_JOBS=5`, `SCENE_CONCURRENCY=3`**

- 5 pipelines run simultaneously, each processing 3 scenes in parallel
- The remaining 5 requests sit in the Redis queue and start as soon as a slot frees up
- Total Chromium instances at peak: 15 (5 jobs x 3 scenes)
- To run all 10 simultaneously, set `MAX_CONCURRENT_JOBS=10` → 30 Chromium instances at peak, requires a larger VM (`c2-standard-30`)

### Idempotency

Derive a job key from content: `pipeline:M2_L3_ML3_en` or `regen:M2_L3_ML3_en:SC3`

If an active job exists with the same key → return existing jobId (don't duplicate work).

### Job Lifecycle

```
queued → active → completed
                → failed (with error message, retryable)
```

- Jobs auto-expire from Redis after 24 hours
- Failed jobs retain error details for debugging
- Video files persist on disk until explicitly cleaned

---

## Resource Sizing

### Per Pipeline Run

| Component | RAM | CPU |
|-----------|-----|-----|
| Chromium instances (3 concurrent scenes) | 600MB - 1GB | 1-2 cores |
| FFmpeg (screenshot compile + stitching) | 200-300MB | 1-2 cores |
| Node.js + Gemini API calls | 100-200MB | minimal |
| **Total per pipeline** | **~1 - 1.5GB** | **2-4 cores** |

### Scaling Table

| Concurrent Pipelines | RAM Needed | CPU Cores | GCP Machine Type | vCPUs / RAM | Monthly Cost (est.) |
|---------------------|-----------|-----------|-------------------|-------------|---------------------|
| 3 | 6GB | 8 | `e2-standard-8` | 8 / 32GB | ~$190 |
| 5 | 10GB | 12 | `c2-standard-8` | 8 / 32GB | ~$250 |
| 10 | 20GB | 16 | `c2-standard-16` | 16 / 64GB | ~$500 |
| 15+ | 30GB | 24+ | `c2-standard-30` | 30 / 120GB | ~$920 |

> Prices are approximate for `us-central1`, on-demand. Sustained-use discounts (automatic) reduce these by ~20%. Committed-use contracts reduce by ~50%.

Recommendation: Start with `c2-standard-8` (8 vCPUs, 32GB RAM) for 5 concurrent pipelines. Scale up to `c2-standard-16` when demand grows — it's a single `gcloud` command to resize.

---

## GCP Deployment

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  GCP Project                     │
│                                                  │
│  ┌──────────┐    ┌──────────────────────────┐   │
│  │  Cloud   │    │   GCE VM (c2-standard-16) │   │
│  │  Armor   │───→│                            │   │
│  │  (WAF)   │    │  nginx (:443)              │   │
│  └──────────┘    │    ↓                       │   │
│                  │  Fastify (:3000)            │   │
│                  │    ↓                       │   │
│                  │  BullMQ Workers             │   │
│                  │    ↓                       │   │
│                  │  Redis (Memorystore)  ←────┼───┤
│                  │    ↓                       │   │
│                  │  /outputs/ (Persistent SSD) │   │
│                  └──────────────────────────┘   │
│                                                  │
│  ┌──────────────┐   ┌─────────────────────┐    │
│  │ Cloud Storage │   │ Gemini API          │    │
│  │ (long-term    │   │ (LLM HTML gen)      │    │
│  │  video store) │   └─────────────────────┘    │
│  └──────────────┘                                │
└─────────────────────────────────────────────────┘
```

### Step-by-Step Deployment (Start to Finish)

> Follow these steps in order. Each step depends on the previous one completing successfully.

---

#### Step 1: Build the API Server Code (Local Machine)

Before deploying, the API server files need to be created in the project:

```
src/server/index.js
src/server/config.js
src/server/routes/jobs.js
src/server/routes/health.js
src/server/queue/job-store.js
src/server/queue/processors/full-pipeline.js
src/server/queue/processors/regen-scene.js
scripts/start-server.js
ecosystem.config.cjs
```

Install the new dependencies locally:

```bash
npm install fastify bullmq ioredis @fastify/cors uuid
```

Add scripts to `package.json`:

```json
"scripts": {
  "server": "node scripts/start-server.js",
  "server:dev": "node --watch scripts/start-server.js"
}
```

Test locally (requires Redis running on localhost):

```bash
# Terminal 1: Start Redis
redis-server

# Terminal 2: Start VCF API
npm run server

# Terminal 3: Test
curl http://localhost:3000/health
```

---

#### Step 2: Create the GCE VM

```bash
gcloud compute instances create vcf-api \
  --machine-type=c2-standard-16 \
  --zone=us-central1-a \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-ssd \
  --tags=http-server,https-server
```

SSH into the VM:

```bash
gcloud compute ssh vcf-api --zone=us-central1-a
```

---

#### Step 3: Install System Dependencies on VM

```bash
# Update packages
sudo apt-get update && sudo apt-get upgrade -y

# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Verify
node --version   # Should be v20.x+
npm --version

# FFmpeg (required for video recording + stitching)
sudo apt-get install -y ffmpeg

# Verify
ffmpeg -version

# Playwright's Chromium + system deps (required for screenshot-based recording)
npx playwright install --with-deps chromium

# PM2 for process management
sudo npm install -g pm2
```

---

#### Step 4: Install and Configure Redis

**Option A: Local Redis on the same VM (simpler, good for starting out)**

```bash
sudo apt-get install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server

# Verify
redis-cli ping   # Should return PONG
```

Set in `.env`: `REDIS_URL=redis://localhost:6379`

**Option B: GCP Memorystore (recommended for production)**

```bash
gcloud redis instances create vcf-redis \
  --size=1 \
  --region=us-central1 \
  --tier=basic \
  --redis-version=redis_7_0

# Get the IP
gcloud redis instances describe vcf-redis --region=us-central1 --format='value(host)'
```

Set in `.env`: `REDIS_URL=redis://<memorystore-ip>:6379`

> Note: Memorystore is only accessible from within the same VPC. The GCE VM connects to it via internal IP.

---

#### Step 5: Clone and Setup the Project

```bash
# Clone repo (or scp/rsync your code)
git clone <your-repo-url> /opt/vcf
cd /opt/vcf

# Install Node dependencies
npm install

# Create .env file with all required keys
cat > .env << 'EOF'
# Server
PORT=3000
NODE_ENV=production
REDIS_URL=redis://localhost:6379
MAX_CONCURRENT_JOBS=5
SCENE_CONCURRENCY=3

# API Keys
GOOGLE_GENAI_API_KEY=your_gemini_key_here
ELEVENLABS_API_KEY=your_elevenlabs_key_here
AZURE_STORAGE_CONNECTION_STRING=your_azure_connection_string_here
EOF

# Verify Playwright browsers are available
npx playwright install chromium
```

---

#### Step 6: Test the Server Manually

```bash
cd /opt/vcf

# Start server in foreground to check for errors
node scripts/start-server.js

# In another SSH session, test health endpoint
curl http://localhost:3000/health
# Should return: {"status":"ok","queueSize":0}

# If everything works, Ctrl+C to stop
```

---

#### Step 7: Configure Firewall Rules

**Option A: No domain (IP-only access via HTTP)**

```bash
# Allow HTTP traffic directly to the VM
gcloud compute firewall-rules create allow-http \
  --allow=tcp:80 \
  --target-tags=http-server

# DO NOT expose port 3000 directly — nginx will reverse-proxy to it
```

**Option B: With domain (HTTPS)**

```bash
gcloud compute firewall-rules create allow-https \
  --allow=tcp:443 \
  --target-tags=https-server

gcloud compute firewall-rules create allow-http \
  --allow=tcp:80 \
  --target-tags=http-server
```

Get your VM's external IP (you'll need this for either option):

```bash
gcloud compute instances describe vcf-api \
  --zone=us-central1-a \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
# Example: 34.123.45.67
```

> **Tip:** Reserve a static IP so it doesn't change on VM restart:
> ```bash
> gcloud compute addresses create vcf-ip --region=us-central1
> gcloud compute instances delete-access-config vcf-api --zone=us-central1-a --access-config-name="External NAT"
> gcloud compute instances add-access-config vcf-api --zone=us-central1-a --address=$(gcloud compute addresses describe vcf-ip --region=us-central1 --format='value(address)')
> ```

---

#### Step 8: Setup nginx Reverse Proxy

```bash
sudo apt-get install -y nginx
```

**Option A: No domain — HTTP only (IP-based access)**

```bash
sudo tee /etc/nginx/sites-available/vcf-api << 'EOF'
server {
    listen 80;
    server_name _;

    client_max_body_size 50M;
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Stream video downloads without buffering
    location ~ ^/api/jobs/.+/video$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
EOF

# Enable the site
sudo ln -s /etc/nginx/sites-available/vcf-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test config and reload
sudo nginx -t
sudo systemctl reload nginx

# Verify — use the external IP from Step 7
curl http://34.123.45.67/health
```

Your API is now accessible at `http://<EXTERNAL_IP>` (port 80). No domain or SSL needed.

> **Security note:** HTTP traffic is unencrypted. This is fine for internal/private use within your team. If the API will be called over the public internet with sensitive data, consider adding a domain + SSL (Option B) or restricting firewall rules to your Python server's IP only:
> ```bash
> gcloud compute firewall-rules create allow-http-restricted \
>   --allow=tcp:80 \
>   --source-ranges=<YOUR_PYTHON_SERVER_IP>/32 \
>   --target-tags=http-server
> ```

**Option B: With domain — HTTPS + SSL**

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

Point your domain's DNS (e.g., `vcf-api.yourdomain.com`) to the VM's external IP, then:

```bash
sudo tee /etc/nginx/sites-available/vcf-api << 'EOF'
server {
    listen 80;
    server_name vcf-api.yourdomain.com;

    client_max_body_size 50M;
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ ^/api/jobs/.+/video$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/vcf-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Install SSL certificate (auto-configures nginx for HTTPS)
sudo certbot --nginx -d vcf-api.yourdomain.com
sudo certbot renew --dry-run

# Verify
curl https://vcf-api.yourdomain.com/health
```

---

#### Step 9: Setup PM2 for Production

Create the PM2 ecosystem config:

```bash
cat > /opt/vcf/ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'vcf-api',
    script: 'scripts/start-server.js',
    cwd: '/opt/vcf',
    instances: 1,                // Single process — BullMQ handles job concurrency
    max_memory_restart: '4G',    // Restart if memory exceeds 4GB (leak protection)
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    }
  }]
};
EOF
```

Start with PM2:

```bash
cd /opt/vcf

# Start the server
pm2 start ecosystem.config.cjs

# Verify it's running
pm2 status
pm2 logs vcf-api --lines 20

# Save the process list so PM2 restarts it after reboot
pm2 save

# Setup PM2 to start on system boot
pm2 startup
# → Copy and run the command it outputs (sudo env PATH=... pm2 startup ...)
```

---

#### Step 10: Verify End-to-End

From your **local machine or Python environment** (use your IP or domain):

```bash
# Replace with your actual IP or domain
VCF_URL="http://34.123.45.67"
# VCF_URL="https://vcf-api.yourdomain.com"

# Health check
curl $VCF_URL/health

# Submit a test job (replace with your actual storyboard JSON)
curl -X POST $VCF_URL/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"storyboard": {...}, "options": {"concurrency": 3}}'

# Poll status
curl $VCF_URL/api/jobs/<jobId>

# Download video
curl -o test_video.mp4 $VCF_URL/api/jobs/<jobId>/video
```

---

#### Step 11: Monitoring and Maintenance

```bash
# View live logs
pm2 logs vcf-api

# Monitor CPU/memory in real-time
pm2 monit

# Restart after code update
cd /opt/vcf && git pull && npm install && pm2 restart vcf-api

# Check Redis queue status
redis-cli LLEN bull:video-pipeline:wait     # Queued jobs
redis-cli SCARD bull:video-pipeline:active   # Active jobs

# Disk usage (output videos accumulate)
du -sh /opt/vcf/outputs/

# Clean up old outputs (older than 7 days)
find /opt/vcf/outputs/ -name "*.mp4" -mtime +7 -delete
```

---

#### Step 12: Updating the Code

When you push changes to the repo:

```bash
# SSH into VM
gcloud compute ssh vcf-api --zone=us-central1-a

# Pull latest code
cd /opt/vcf
git pull origin main

# Install any new dependencies
npm install

# Restart the server (zero-downtime with PM2)
pm2 restart vcf-api

# Verify
pm2 logs vcf-api --lines 10
curl https://vcf-api.yourdomain.com/health
```

---

## Python Client Integration

### Install Dependencies

```bash
pip install requests
```

### VCF Client Class

```python
import requests
import time
import json
import os
import logging

logger = logging.getLogger("vcf_client")


class VCFClient:
    """
    Client for the Video Content Factory API.

    Usage:
        # With domain + SSL
        client = VCFClient("https://vcf-api.yourdomain.com")

        # Without domain — just use the VM's external IP
        client = VCFClient("http://34.123.45.67")

        # Full pipeline
        video_path = client.generate_video(storyboard_json, output_dir="./videos")

        # Regenerate a single scene
        video_path = client.regenerate_scene(module=2, lesson=3, ml=3, scene="SC3")
    """

    def __init__(self, base_url: str, timeout: int = 30, poll_interval: int = 15):
        """
        Args:
            base_url: VCF API base URL (e.g., "https://vcf-api.yourdomain.com")
            timeout: HTTP request timeout in seconds
            poll_interval: Seconds between status polls
        """
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})

    # ─── Health Check ────────────────────────────────────────────

    def health(self) -> dict:
        """Check if the VCF API is up and get queue status."""
        resp = self.session.get(f"{self.base_url}/health", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()

    # ─── Full Pipeline ───────────────────────────────────────────

    def generate_video(
        self,
        storyboard: dict,
        output_dir: str = "./videos",
        concurrency: int = 3,
        fps: int = 24,
        gap_ms: int = 700,
        theme_override: str = None,
    ) -> str:
        """
        Run the full pipeline: TTS → Avatar → HTML → Record → Stitch.

        Args:
            storyboard: The storyboard JSON dict (same format as 8.2_media_prompts_en_M2_L3_ML3.json)
            output_dir: Local directory to save the downloaded video
            concurrency: Max parallel scenes within this job (default 3)
            fps: Video frames per second (default 24)
            gap_ms: Gap between scenes in ms (default 700)
            theme_override: Override theme name (e.g., "dark_blue"), or None for default

        Returns:
            str: Local file path of the downloaded video

        Raises:
            RuntimeError: If the pipeline job fails
            requests.HTTPError: If API returns an error status code
        """

        # ── Build payload ────────────────────────────────────────
        payload = {
            "storyboard": storyboard,
            "options": {
                "concurrency": concurrency,
                "fps": fps,
                "gapMs": gap_ms,
            }
        }
        if theme_override:
            payload["options"]["themeOverride"] = theme_override

        # ── Submit job ───────────────────────────────────────────
        logger.info("Submitting full pipeline job...")
        resp = self.session.post(
            f"{self.base_url}/api/jobs",
            json=payload,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        job_data = resp.json()
        job_id = job_data["jobId"]
        logger.info(f"Job submitted: {job_id}")

        # ── Poll until done ──────────────────────────────────────
        result = self._poll_job(job_id)

        # ── Download video ───────────────────────────────────────
        video_path = self._download_video(job_id, result, output_dir)
        return video_path

    # ─── Scene Regeneration ──────────────────────────────────────

    def regenerate_scenes(
        self,
        module: int,
        lesson: int,
        ml: int,
        scenes: list[str],
        language: str = "en",
        skip_tts: bool = True,
        skip_avatar: bool = True,
        output_dir: str = "./videos",
    ) -> str:
        """
        Regenerate one or more scenes (new HTML + record) and re-stitch the full video.

        Use this when scene layouts need fixing — it regenerates the HTML via LLM,
        re-records the specified scenes, then stitches ALL scenes into a new final video.

        Args:
            module: Module number (e.g., 2)
            lesson: Lesson number (e.g., 3)
            ml: Micro-lesson number (e.g., 3)
            scenes: List of scene IDs to regenerate (e.g., ["SC3"] or ["SC3", "SC7", "SC12"])
            language: Language code (default "en")
            skip_tts: Skip TTS generation, reuse existing audio (default True)
            skip_avatar: Skip avatar generation, reuse existing avatar (default True)
            output_dir: Local directory to save the downloaded video

        Returns:
            str: Local file path of the downloaded video
        """

        # ── Build payload ────────────────────────────────────────
        payload = {
            "module": module,
            "lesson": lesson,
            "ml": ml,
            "language": language,
            "scenes": scenes,
            "skipTTS": skip_tts,
            "skipAvatar": skip_avatar,
        }

        # ── Submit job ───────────────────────────────────────────
        logger.info(f"Submitting scene regeneration: M{module}_L{lesson}_ML{ml} {scenes}...")
        resp = self.session.post(
            f"{self.base_url}/api/jobs/regenerate-scene",
            json=payload,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        job_data = resp.json()
        job_id = job_data["jobId"]
        logger.info(f"Regen job submitted: {job_id}")

        # ── Poll until done ──────────────────────────────────────
        result = self._poll_job(job_id)

        # ── Download video ───────────────────────────────────────
        video_path = self._download_video(job_id, result, output_dir)
        return video_path

    # ─── Polling ─────────────────────────────────────────────────

    def _poll_job(self, job_id: str) -> dict:
        """Poll job status until completed or failed."""
        while True:
            resp = self.session.get(
                f"{self.base_url}/api/jobs/{job_id}",
                timeout=self.timeout,
            )
            resp.raise_for_status()
            status = resp.json()

            current = status["status"]
            progress = status.get("progress", "")
            logger.info(f"  [{job_id}] {current} — {progress}")

            if current == "completed":
                return status.get("result", {})

            if current == "failed":
                error = status.get("error", "Unknown error")
                raise RuntimeError(f"Job {job_id} failed: {error}")

            time.sleep(self.poll_interval)

    # ─── Download ────────────────────────────────────────────────

    def _download_video(self, job_id: str, result: dict, output_dir: str) -> str:
        """Download the completed video to a local file."""
        os.makedirs(output_dir, exist_ok=True)

        # Use the filename from the result, or fall back to jobId
        filename = result.get("fileName", f"{job_id}.mp4")
        local_path = os.path.join(output_dir, filename)

        logger.info(f"Downloading video → {local_path}")
        resp = self.session.get(
            f"{self.base_url}/api/jobs/{job_id}/video",
            stream=True,
            timeout=300,  # longer timeout for large video downloads
        )
        resp.raise_for_status()

        total_bytes = 0
        with open(local_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
                total_bytes += len(chunk)

        size_mb = total_bytes / (1024 * 1024)
        logger.info(f"Downloaded {size_mb:.1f}MB → {local_path}")
        return local_path
```

### Usage Examples

#### 1. Full Pipeline — Generate Video from Storyboard

```python
import json

# Initialize client — use IP or domain
client = VCFClient("http://34.123.45.67")          # No domain
# client = VCFClient("https://vcf-api.yourdomain.com")  # With domain

# Check API health first
health = client.health()
print(f"API status: {health['status']}, queue depth: {health.get('queueSize', 0)}")

# Load your storyboard JSON (same format as sample/8.2_media_prompts_en_M2_L3_ML3.json)
with open("storyboard_M2_L3_ML3.json") as f:
    storyboard = json.load(f)

# Generate — blocks until video is ready
video_path = client.generate_video(
    storyboard=storyboard,
    output_dir="./output/videos",
    concurrency=3,
    fps=24,
)
print(f"Video saved to: {video_path}")
# → ./output/videos/M2_L3_ML3_Complete_en.mp4
```

#### 2. Regenerate a Single Scene

```python
# Single scene — SC3 had a layout issue
video_path = client.regenerate_scenes(
    module=2,
    lesson=3,
    ml=3,
    scenes=["SC3"],
    language="en",
    skip_tts=True,      # Reuse existing TTS audio
    skip_avatar=True,    # Reuse existing avatar video
    output_dir="./output/videos",
)
print(f"Updated video: {video_path}")
# → ./output/videos/M2_L3_ML3_Complete_en.mp4 (with new SC3)

# Multiple scenes at once — SC3 and SC7 both need new layouts
video_path = client.regenerate_scenes(
    module=2,
    lesson=3,
    ml=3,
    scenes=["SC3", "SC7", "SC12"],
    output_dir="./output/videos",
)
print(f"Updated video: {video_path}")
# → re-generates SC3, SC7, SC12 then re-stitches all scenes
```

#### 4. Error Handling

> **Note:** Multiple people/pipelines can call `generate_video()` independently at the same time. The VCF API queues all incoming requests via Redis and processes them based on `MAX_CONCURRENT_JOBS`. No thread pooling or batching needed on the Python side — just a simple single call per request.

```python
from requests.exceptions import ConnectionError, Timeout, HTTPError

client = VCFClient("http://34.123.45.67")  # or "https://vcf-api.yourdomain.com"

try:
    video_path = client.generate_video(storyboard, output_dir="./videos")
    print(f"Success: {video_path}")

except ConnectionError:
    print("VCF API is not reachable — check if the server is running")

except Timeout:
    print("Request timed out — API might be overloaded")

except HTTPError as e:
    if e.response.status_code == 409:
        print("A job for this ML is already running — wait for it to complete")
    elif e.response.status_code == 429:
        print("Queue is full — try again later")
    else:
        print(f"API error: {e.response.status_code} {e.response.text}")

except RuntimeError as e:
    # Pipeline job failed (e.g., LLM error, FFmpeg crash)
    print(f"Pipeline failed: {e}")
```

#### 5. Integration in an Existing Python Pipeline

```python
# your_pipeline.py — called for each micro-lesson

def process_micro_lesson(module: int, lesson: int, ml: int, language: str = "en"):
    """Your existing Python pipeline step that generates the storyboard."""

    # Step 1: Generate storyboard (your existing logic)
    storyboard = build_storyboard(module, lesson, ml, language)

    # Step 2: Send to VCF for video generation
    vcf = VCFClient("http://34.123.45.67")  # or "https://vcf-api.yourdomain.com"
    video_path = vcf.generate_video(
        storyboard=storyboard,
        output_dir=f"./output/M{module}_L{lesson}_ML{ml}",
    )

    # Step 3: Upload to your storage / LMS / CDN
    upload_to_cdn(video_path)

    return video_path
```

---

## Platforms NOT Suitable for This Workload

### Cloud Run / Cloud Functions

- **Hard timeout limits**: Cloud Run max 60 min (but 10 min default), Cloud Functions max 9 min. Pipeline runs can exceed these.
- **No persistent filesystem**: Output videos, frame screenshots, temp files all need disk. Cloud Run's `/tmp` is ephemeral and limited (usually 512MB-1GB).
- **Cold starts**: Chromium + Playwright install is ~400MB. Cold start would take 30+ seconds.
- **Memory limits**: Cloud Run max 32GB but billed per 100ms. A 5-minute pipeline at 4GB = expensive.
- **No background processing**: Request must stay open for the entire pipeline duration. Connection drops = lost work.

### App Engine (Standard)

- **No FFmpeg or Chromium**: Sandboxed runtime, can't install system dependencies.
- **Request timeout**: 60 seconds for standard, 10 minutes for flexible. Not enough.

### App Engine (Flexible)

- **Slow deploys**: Custom Docker image with Chromium + FFmpeg = 5-10 min deploy times.
- **No persistent disk**: Ephemeral filesystem, same issue as Cloud Run.
- **Cost**: Always-on instances billed per hour, no scale-to-zero. More expensive than a VM for this workload.

### Kubernetes (GKE)

- **Overkill for this scale**: Adds significant operational complexity (pod scheduling, resource requests/limits, persistent volume claims, node pools) for what is essentially 1-2 worker processes.
- **Chromium in containers is fragile**: Requires specific seccomp profiles, `--no-sandbox` flags, shared memory configuration (`/dev/shm`).
- **Could be right later**: If you need 50+ concurrent pipelines across multiple machines, GKE with a Redis-backed queue makes sense. Not needed at 5-15 concurrent.

### Railway / Render / Fly.io

- **RAM limits**: Most plans cap at 8GB. Not enough for 5+ concurrent pipelines.
- **No persistent disk**: Videos would need to be uploaded to cloud storage immediately.
- **Timeout limits**: Railway has 15-minute request timeout.
- **Shared infrastructure**: Noisy neighbor issues on CPU-intensive workloads.

### AWS Lambda / Azure Functions

- Same issues as Cloud Functions: timeout limits, no persistent filesystem, cold starts, no Chromium.

---

## Why GCE VM is the Right Choice

1. **Full control**: Install Chromium, FFmpeg, Redis, any system deps
2. **Persistent SSD**: Output videos stay on disk, fast read/write for frame screenshots
3. **No timeout limits**: Pipeline runs as long as it needs
4. **Predictable cost**: Fixed monthly cost regardless of pipeline duration
5. **Gemini proximity**: Same GCP network = low latency LLM calls (important since each scene makes a Gemini API call)
6. **Simple scaling**: Resize the VM (`gcloud compute instances set-machine-type`) when you need more power
7. **Docker optional**: Can run directly on the VM with PM2, or Dockerize later if needed

---

## Environment Variables

```env
# Server
PORT=3000
NODE_ENV=production

# Redis
REDIS_URL=redis://10.x.x.x:6379

# Pipeline
MAX_CONCURRENT_JOBS=5
SCENE_CONCURRENCY=3

# Existing env vars
GOOGLE_GENAI_API_KEY=...
ELEVENLABS_API_KEY=...
AZURE_STORAGE_CONNECTION_STRING=...
```

---

## Monitoring (Optional but Recommended)

- **PM2 metrics**: `pm2 monit` for real-time CPU/memory
- **BullMQ dashboard**: `bull-board` or `arena` npm packages — web UI for queue monitoring
- **GCP Cloud Monitoring**: VM CPU/memory/disk alerts
- **Structured logging**: Add request IDs and job IDs to all console.log for tracing

---

## Summary

| Decision | Choice |
|----------|--------|
| Compute | GCE VM (`c2-standard-16`) |
| Queue | BullMQ + Redis (Memorystore) |
| HTTP | Fastify |
| Process Manager | PM2 |
| Reverse Proxy | nginx + Certbot SSL |
| Concurrent Pipelines | 5-10 (configurable) |
| Region | `us-central1` (close to Gemini API) |
| Estimated Cost | ~$400-500/month (VM + Redis + network) |
