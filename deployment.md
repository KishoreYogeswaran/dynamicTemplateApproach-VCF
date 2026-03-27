# Video Content Factory — API Service & Deployment Plan

## Overview

The Video Content Factory (VCF) pipeline converts storyboard JSON into fully rendered educational videos. This document covers the API service architecture, deployment strategy on GCP, and scaling considerations.

**Workload profile:** CPU/RAM intensive, long-running (2-10 min per pipeline), parallel requests from multiple Python pipelines.

---

## Parallel I/O & Frame Extraction

Each scene recording captures JPEG frames to a temporary directory on disk, then compiles them to H.264 via FFmpeg. When multiple jobs run in parallel, this creates concurrent disk I/O.

### How Collisions Are Avoided

Each recording creates an isolated frames directory using a timestamp-based name:

```
/opt/vcf/outputs/.../video/_frames_1711234567890/   ← Job A, Scene 1
/opt/vcf/outputs/.../video/_frames_1711234567895/   ← Job B, Scene 3 (parallel)
```

The `_frames_${Date.now()}` naming ensures no two recordings write to the same directory, even when 15+ scenes record simultaneously.

### I/O Load at Peak Concurrency

With `MAX_CONCURRENT_JOBS=5` and `SCENE_CONCURRENCY=3` (15 parallel recordings):

| Metric | Per Scene | 15 Parallel Scenes |
|--------|-----------|-------------------|
| Frames written | ~150 files | ~2,250 files |
| Disk written | ~30MB | ~450MB |
| Duration | 5-10s of I/O | Same (parallel) |

### Why SSD Handles This Easily

The `pd-ssd` disk specified in Step 2 provides **15,000-30,000 IOPS** and **240-480 MB/s throughput**. Peak pipeline load is ~2,000 IOPS — well under 15% of the disk's capacity.

Frames are also **short-lived** — written during capture, read once by FFmpeg, then immediately deleted. There is no accumulation of frame files on disk.

### Actual Bottleneck

At scale, the bottleneck is **CPU** (Chromium rendering) and **RAM** (15 headless browser instances), not disk I/O. The `c2-standard-16` machine type has sufficient compute and memory for 5 concurrent pipelines.

---

## API Architecture

### Endpoints

```
POST /api/jobs                    Full pipeline run
POST /api/jobs/regenerate-scene   Scene regen (returns individual scene MP4s)
POST /api/jobs/human-review       Re-generate scene from reviewer feedback
GET  /api/jobs/:jobId             Poll job status
GET  /api/jobs/:jobId/video?scene=SC1  Download individual scene MP4
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

Regenerates specific scenes (LLM HTML + record). Returns individual scene MP4s — stitching is handled by the caller (Python pipeline).

Pass the full storyboard in the request body. If you edited VO scripts or scene content, the pipeline picks up the changes. Set `skipTTS: false` / `skipAvatar: false` to re-generate TTS / avatar from the updated storyboard.

```
POST /api/jobs/regenerate-scene
Content-Type: application/json

{
  "storyboard": { ... },           // Full storyboard JSON (required)
  "scenes": ["SC3"],               // Single or multiple: ["SC3", "SC7", "SC12"]
  "skipTTS": true,                  // default: true (reuse existing audio)
  "skipAvatar": true                // default: true (reuse existing avatar)
}

Response: { "jobId": "def456", "status": "queued" }
```

Internal flow:
1. Write storyboard to temp file
2. Run pipeline for each scene in the `scenes` array (with specified skip flags)
3. Return individual scene MP4s (only the regenerated scenes)

### Human Review

Re-generates a single scene based on human reviewer feedback (e.g. layout adjustments, font size changes, element repositioning). Skips TTS and avatar generation — only the visual layout is regenerated. The LLM receives the previous output + the reviewer's comment and changes only what was requested. Validation retries run as normal.

**Prerequisite:** The scene must have been generated at least once (the pipeline saves an `llm-results/<sceneId>.json` file during generation that is required for review).

```
POST /api/jobs/human-review
Content-Type: application/json

{
  "storyboard": { ... },           // Full storyboard JSON (required)
  "scene": "SC12",
  "comment": "Move the OST to bottom right not top left"
}

Response: { "jobId": "ghi789", "status": "queued" }
```

Internal flow:
1. Write storyboard to temp file
2. Load saved LLM result from `llm-results/<sceneId>.json`
3. Build review prompt with human comment + previous output + original design requirements
4. LLM regenerates (only changes what was requested) → validate + retry loop
5. Re-record scene with Puppeteer
6. Return the single reviewed scene MP4

CLI equivalent:
```bash
node scripts/run-pipeline.js --module 2 --lesson 7 --ml 2 --scene SC12 --humanComment "Move the OST to bottom right not top left"
```

### Poll Status

```
GET /api/jobs/:jobId

Response:
{
  "jobId": "abc123",
  "status": "active",           // queued | active | completed | failed
  "progress": "Recording SC5",  // Human-readable progress
  "createdAt": "2026-03-25T10:00:00Z",
  "result": null                // On completion: { scenes: [{ sceneId, videoPath, fileName }] }
}
```

### Download Scene Video

```
GET /api/jobs/:jobId/video?scene=SC1

Response: MP4 binary stream
Content-Type: video/mp4
Content-Disposition: attachment; filename="M2_L3_ML3_SC1.mp4"
```

- If the job has **one scene**, you can omit `?scene=` and it returns that scene directly
- If the job has **multiple scenes**, `?scene=` is required — without it, the API returns the list of available scene IDs

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
        full-pipeline.js     Worker: full pipeline (all scenes)
        regen-scene.js       Worker: regenerate specific scenes
        human-review.js      Worker: re-generate from reviewer feedback
scripts/
  start-server.js            Entry point: loads env, starts server
  cleanup.js                 TTL-based cleanup for video files and temp storyboards
ecosystem.config.cjs         PM2 config: vcf-api + vcf-cleanup cron
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
src/server/queue/processors/human-review.js
scripts/start-server.js
scripts/cleanup.js
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

> **Why PM2?** Running `node server.js` directly dies the moment you close the SSH session. PM2 is a process manager that keeps the server running as a background daemon, auto-restarts it if it crashes, survives VM reboots (`pm2 startup`), captures logs, and can run scheduled cron jobs — all without a separate init system.

The `ecosystem.config.cjs` file is already in the repo. It configures two PM2 apps:

- **vcf-api** — the Fastify server (always running)
- **vcf-cleanup** — daily cleanup cron at 3 AM (deletes video MP4s older than 7 days, temp files older than 12 hours)

> **No need to create this file manually** — it's deployed with the repo in Step 5. If you need to customize TTL values, edit the env vars in the file:
> ```js
> // In ecosystem.config.cjs → vcf-cleanup → env
> VIDEO_TTL_DAYS: 7,       // Change to desired retention period
> TMP_TTL_HOURS: 12,       // Change to desired temp file retention
> ```

Start with PM2:

```bash
cd /opt/vcf

# Start both apps (server + cleanup cron)
pm2 start ecosystem.config.cjs

# Verify both are running
pm2 status
# vcf-api      should show "online"
# vcf-cleanup  should show "stopped" with cron pattern (runs at 3 AM daily)

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

# Download a scene video (use a scene ID from the result)
curl -o test_scene.mp4 "$VCF_URL/api/jobs/<jobId>/video?scene=SC1"
```

---

#### Step 11: Monitoring and Maintenance

```bash
# View live logs
pm2 logs vcf-api

# Monitor CPU/memory in real-time
pm2 monit

# Restart after code update
cd /opt/vcf && git pull && npm install && pm2 restart ecosystem.config.cjs

# Check Redis queue status
redis-cli LLEN bull:video-pipeline:wait     # Queued jobs
redis-cli SCARD bull:video-pipeline:active   # Active jobs

# Disk usage (output videos accumulate)
du -sh /opt/vcf/outputs/
```

#### Automated Cleanup

Cleanup is handled by the `vcf-cleanup` PM2 cron job (configured in `ecosystem.config.cjs`, started in Step 9). It runs daily at 3 AM and deletes:

| What gets cleaned | Retention | Why |
|-------------------|-----------|-----|
| `video/*.mp4` (scene videos) | 7 days | Python client downloads immediately; 7-day buffer for re-downloads |
| `tmp/storyboard_*.json` (temp files) | 12 hours | Only needed during job execution |
| Job metadata (Redis) | 24 hours | `JOB_TTL_HOURS=24` — after this, `GET /api/jobs/:id` returns 404 |

**Preserved indefinitely** (needed for regen / human review):
- `audio/` — TTS mp3s (FFmpeg mux during re-recording)
- `html/` — generated HTML files
- `avatar/` — avatar .webm files (expensive to regenerate)
- `llm-results/` — saved LLM JSON (human review base)

To run cleanup manually:

```bash
cd /opt/vcf

# Dry run — see what would be deleted
node scripts/cleanup.js

# Actually delete
node scripts/cleanup.js --run

# Custom retention
VIDEO_TTL_DAYS=3 node scripts/cleanup.js --run
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

# Restart all apps (server + cleanup cron)
pm2 restart ecosystem.config.cjs

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

    All endpoints return individual scene MP4s (no stitching on server).
    Stitching is handled by the caller's Python pipeline.

    Usage:
        client = VCFClient("http://34.123.45.67")

        # Full pipeline — returns all scene videos
        scenes = client.generate_video(storyboard_json, output_dir="./videos")

        # Regenerate scenes — returns only regenerated scene videos
        scenes = client.regenerate_scenes(storyboard=storyboard_json, scenes=["SC3"])

        # Human review — returns the reviewed scene video
        scenes = client.human_review(storyboard=storyboard_json, scene="SC12", comment="...")
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
    ) -> list[dict]:
        """
        Run the full pipeline: TTS → Avatar → HTML → Record.
        Returns individual scene MP4s (no stitching — handle that in your pipeline).

        Args:
            storyboard: The storyboard JSON dict (same format as 8.2_media_prompts_en_M2_L3_ML3.json)
            output_dir: Local directory to save the downloaded videos
            concurrency: Max parallel scenes within this job (default 3)
            fps: Video frames per second (default 24)
            gap_ms: Gap between scenes in ms (default 700)
            theme_override: Override theme name (e.g., "dark_blue"), or None for default

        Returns:
            list[dict]: List of { sceneId, localPath } for each downloaded scene video

        Raises:
            RuntimeError: If the pipeline job fails
            requests.HTTPError: If API returns an error status code
        """

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

        result = self._poll_job(job_id)

        return self._download_scenes(job_id, result, output_dir)

    # ─── Scene Regeneration ──────────────────────────────────────

    def regenerate_scenes(
        self,
        storyboard: dict,
        scenes: list[str],
        skip_tts: bool = True,
        skip_avatar: bool = True,
        output_dir: str = "./videos",
    ) -> list[dict]:
        """
        Regenerate one or more scenes (new HTML + record).
        Returns only the regenerated scene MP4s.

        Pass the full (possibly updated) storyboard — if you edited VO scripts,
        scene content, or any other field, the pipeline picks up the changes.
        Set skip_tts=False / skip_avatar=False to re-generate TTS / avatar
        from the updated storyboard.

        Args:
            storyboard: Full storyboard JSON dict (same format as generate_video)
            scenes: List of scene IDs to regenerate (e.g., ["SC3"] or ["SC3", "SC7", "SC12"])
            skip_tts: Skip TTS generation, reuse existing audio (default True)
            skip_avatar: Skip avatar generation, reuse existing avatar (default True)
            output_dir: Local directory to save the downloaded videos

        Returns:
            list[dict]: List of { sceneId, localPath } for each regenerated scene
        """

        payload = {
            "storyboard": storyboard,
            "scenes": scenes,
            "skipTTS": skip_tts,
            "skipAvatar": skip_avatar,
        }

        logger.info(f"Submitting scene regeneration: {scenes}...")
        resp = self.session.post(
            f"{self.base_url}/api/jobs/regenerate-scene",
            json=payload,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        job_data = resp.json()
        job_id = job_data["jobId"]
        logger.info(f"Regen job submitted: {job_id}")

        result = self._poll_job(job_id)

        return self._download_scenes(job_id, result, output_dir)

    # ─── Human Review ─────────────────────────────────────────────

    def human_review(
        self,
        storyboard: dict,
        scene: str,
        comment: str,
        output_dir: str = "./videos",
    ) -> list[dict]:
        """
        Re-generate a single scene based on human reviewer feedback.
        Returns the reviewed scene MP4.

        The LLM receives the previous output + your comment and changes only
        what was requested (layout, positioning, font sizes, etc.).
        Theme colors, fonts, avatars, audio, and text content are preserved.

        Prerequisite: The scene must have been generated at least once
        (the pipeline needs the saved LLM result from the first generation).

        Args:
            storyboard: Full storyboard JSON dict (same format as generate_video)
            scene: Single scene ID (e.g., "SC12")
            comment: Human reviewer feedback (e.g., "Move the OST to bottom right")
            output_dir: Local directory to save the downloaded video

        Returns:
            list[dict]: List with single { sceneId, localPath }
        """

        payload = {
            "storyboard": storyboard,
            "scene": scene,
            "comment": comment,
        }

        logger.info(f"Submitting human review: {scene}...")
        resp = self.session.post(
            f"{self.base_url}/api/jobs/human-review",
            json=payload,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        job_data = resp.json()
        job_id = job_data["jobId"]
        logger.info(f"Review job submitted: {job_id}")

        result = self._poll_job(job_id)

        return self._download_scenes(job_id, result, output_dir)

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

    def _download_scenes(self, job_id: str, result: dict, output_dir: str) -> list[dict]:
        """Download all scene videos from a completed job."""
        os.makedirs(output_dir, exist_ok=True)

        scenes = result.get("scenes", [])
        downloaded = []

        for scene in scenes:
            scene_id = scene["sceneId"]
            filename = scene.get("fileName", f"{scene_id}.mp4")
            local_path = os.path.join(output_dir, filename)

            logger.info(f"Downloading {scene_id} → {local_path}")
            resp = self.session.get(
                f"{self.base_url}/api/jobs/{job_id}/video",
                params={"scene": scene_id},
                stream=True,
                timeout=300,
            )
            resp.raise_for_status()

            total_bytes = 0
            with open(local_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
                    total_bytes += len(chunk)

            size_mb = total_bytes / (1024 * 1024)
            logger.info(f"  {scene_id}: {size_mb:.1f}MB")
            downloaded.append({"sceneId": scene_id, "localPath": local_path})

        return downloaded
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

# Generate — blocks until all scene videos are ready
scenes = client.generate_video(
    storyboard=storyboard,
    output_dir="./output/videos",
    concurrency=3,
    fps=24,
)
# scenes = [
#   {"sceneId": "M2_L3_ML3_SC1", "localPath": "./output/videos/M2_L3_ML3_SC1.mp4"},
#   {"sceneId": "M2_L3_ML3_SC2", "localPath": "./output/videos/M2_L3_ML3_SC2.mp4"},
#   ...
# ]
for s in scenes:
    print(f"  {s['sceneId']} → {s['localPath']}")

# Stitch on your side (Python/FFmpeg) in whatever order you need
```

#### 2. Regenerate a Single Scene

```python
# Load the storyboard (possibly with edits you made)
with open("storyboard_M2_L3_ML3.json") as f:
    storyboard = json.load(f)

# Single scene — SC3 had some issues (reuse existing TTS + avatar)
scenes = client.regenerate_scenes(
    storyboard=storyboard,
    scenes=["SC3"],
    skip_tts=True,      # Reuse existing TTS audio
    skip_avatar=True,    # Reuse existing avatar video
    output_dir="./output/videos",
)
# Returns only the regenerated scene(s)
# scenes = [{"sceneId": "M2_L3_ML3_SC3", "localPath": "./output/videos/M2_L3_ML3_SC3.mp4"}]
print(f"Regenerated: {scenes[0]['localPath']}")

# VO script changed? Set skip_tts=False to re-generate TTS from updated storyboard
scenes = client.regenerate_scenes(
    storyboard=storyboard,       # updated VO text in SC3
    scenes=["SC3"],
    skip_tts=False,              # Re-generate TTS with new script
    skip_avatar=False,           # Re-generate avatar with new audio
    output_dir="./output/videos",
)

# Multiple scenes at once — SC3, SC7, SC12 all need have issues
scenes = client.regenerate_scenes(
    storyboard=storyboard,
    scenes=["SC3", "SC7", "SC12"],
    output_dir="./output/videos",
)
for s in scenes:
    print(f"  Regenerated {s['sceneId']} → {s['localPath']}")
# → only the 3 regenerated scene MP4s are returned
```

#### 3. Human Review — Adjust a Scene from Reviewer Feedback

```python
# Load the storyboard (same one used for generation)
with open("storyboard_M2_L7_ML2.json") as f:
    storyboard = json.load(f)

# Reviewer watched the video and wants the OST moved
scenes = client.human_review(
    storyboard=storyboard,
    scene="SC12",
    comment="Move the OST to bottom right not top left",
    output_dir="./output/videos",
)
# Returns only the reviewed scene
# scenes = [{"sceneId": "M2_L7_ML2_SC12", "localPath": "./output/videos/M2_L7_ML2_SC12.mp4"}]
print(f"Reviewed: {scenes[0]['localPath']}")

# Font size adjustment
scenes = client.human_review(
    storyboard=storyboard,
    scene="SC2",
    comment="Make the bullet text slightly bigger, increase font-size by 4px",
    output_dir="./output/videos",
)

# Multiple rounds of review on the same scene (iterative)
scenes = client.human_review(
    storyboard=storyboard,
    scene="SC12",
    comment="The labels are overlapping the image border, add more padding",
    output_dir="./output/videos",
)
```

#### 4. Error Handling

> **Note:** Multiple people/pipelines can call `generate_video()` independently at the same time. The VCF API queues all incoming requests via Redis and processes them based on `MAX_CONCURRENT_JOBS`. No thread pooling or batching needed on the Python side — just a simple single call per request.

```python
from requests.exceptions import ConnectionError, Timeout, HTTPError

client = VCFClient("http://34.123.45.67")  # or "https://vcf-api.yourdomain.com"

try:
    scenes = client.generate_video(storyboard, output_dir="./videos")
    print(f"Success: {len(scenes)} scene(s) downloaded")
    for s in scenes:
        print(f"  {s['sceneId']} → {s['localPath']}")

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

    # Step 2: Send to VCF for video generation (returns individual scene MP4s)
    vcf = VCFClient("http://34.123.45.67")  # or "https://vcf-api.yourdomain.com"
    scenes = vcf.generate_video(
        storyboard=storyboard,
        output_dir=f"./output/M{module}_L{lesson}_ML{ml}",
    )

    # Step 3: Stitch scenes in order, then upload
    scene_paths = [s["localPath"] for s in scenes]
    final_video = stitch_scenes(scene_paths)  # your FFmpeg stitching logic
    upload_to_cdn(final_video)

    return scenes
```

---

## Storage & Cleanup

### What's Stored on Disk

All pipeline outputs are saved under `outputs/<domain>/<module>/<lesson>/<ml>/<language>/`:

| Directory | Contents | Needed for regen/review? | Auto-cleaned? |
|-----------|----------|--------------------------|---------------|
| `video/` | Scene MP4 files (~2-5MB each) | No — Python client downloads immediately | Yes (7 days) |
| `audio/` | TTS mp3s, alignment JSONs | Yes — FFmpeg mux during re-recording | No |
| `html/` | Generated HTML files | Yes — regeneration reference | No |
| `avatar/` | Avatar .webm files | Yes — reused with `skipAvatar: true` | No |
| `llm-results/` | Saved LLM JSON outputs | Yes — human review builds on these | No |
| `tmp/` | Temp storyboard JSONs from API | No — only needed during job execution | Yes (12 hours) |

> **Note:** The large `.mov` files from Fibo (50-75MB each) are automatically deleted right after compression to `.webm` (2-3MB). No manual cleanup needed.

### Automatic Cleanup

A PM2 cron job (`vcf-cleanup`) runs daily at 3 AM and deletes:
- `video/*.mp4` files older than 7 days
- `tmp/storyboard_*.json` files older than 12 hours

Everything else (`audio/`, `html/`, `avatar/`, `llm-results/`) is preserved indefinitely for regen and human review.

### Configuration

TTL values are set in `ecosystem.config.cjs` and can be overridden via environment variables:

```bash
# In ecosystem.config.cjs (already configured)
VIDEO_TTL_DAYS=7      # Delete scene MP4s after 7 days
TMP_TTL_HOURS=12      # Delete temp storyboard files after 12 hours
```

### Manual Cleanup

```bash
# Dry run — see what would be deleted without deleting anything
node scripts/cleanup.js

# Actually delete
node scripts/cleanup.js --run

# Custom TTL
VIDEO_TTL_DAYS=3 node scripts/cleanup.js --run
```

### Disk Space Planning

Rough estimates per micro-lesson (10 scenes):
- Videos: ~20-50MB (cleaned after 7 days)
- Audio: ~5-10MB (kept)
- HTML: ~1MB (kept)
- Avatars: ~2-4MB as .webm (kept)
- LLM results: ~0.5MB (kept)

For **100 micro-lessons**, expect ~0.7–1.5GB of persistent data (audio + HTML + avatars + LLM results) plus up to ~5GB of video files that rotate out weekly. A **30GB disk** gives plenty of headroom.

### Deployment Checklist for Cleanup

1. PM2 starts both apps automatically:
   ```bash
   pm2 start ecosystem.config.cjs
   # Starts: vcf-api (always running) + vcf-cleanup (cron at 3 AM daily)
   ```

2. Verify cleanup is scheduled:
   ```bash
   pm2 list
   # vcf-cleanup should show status "stopped" with a cron pattern
   ```

3. Test manually on first deploy:
   ```bash
   cd /opt/vcf
   node scripts/cleanup.js          # dry run first
   node scripts/cleanup.js --run    # if output looks correct
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

## CI/CD — Automatic Deployment on Push

### Overview

When you push to `main`, GitHub Actions SSHs into the GCE VM, pulls the latest code, installs dependencies, and restarts PM2. No Docker, no containers — just a direct deploy to the VM.

```
Push to main → GitHub Actions → SSH into VM → git pull → npm install → pm2 restart
```

### Setup (One-Time)

#### 1. Create an SSH key for the deploy bot

On your **local machine** (not the VM):

```bash
ssh-keygen -t ed25519 -f vcf-deploy-key -C "vcf-deploy-bot" -N ""
```

This creates `vcf-deploy-key` (private) and `vcf-deploy-key.pub` (public).

#### 2. Add the public key to the VM

SSH into the VM and add the public key to authorized_keys:

```bash
gcloud compute ssh vcf-api --zone=us-central1-a

# Add the deploy bot's public key
echo "ssh-ed25519 AAAA... vcf-deploy-bot" >> ~/.ssh/authorized_keys
```

Replace with the actual content of `vcf-deploy-key.pub`.

#### 3. Add secrets to GitHub

Go to your repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret Name | Value |
|-------------|-------|
| `VM_SSH_KEY` | Contents of `vcf-deploy-key` (the private key file) |
| `VM_HOST` | Your VM's external IP (e.g., `34.123.45.67`) |
| `VM_USER` | SSH username (usually your GCP username, check with `whoami` on the VM) |

#### 4. Create the workflow file

Create `.github/workflows/deploy.yml` in your repo:

```yaml
name: Deploy to GCE VM

on:
  push:
    branches: [main]
    paths-ignore:
      - '*.md'
      - 'sample/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VM_HOST }}
          username: ${{ secrets.VM_USER }}
          key: ${{ secrets.VM_SSH_KEY }}
          script: |
            cd /opt/vcf

            echo "=== Pulling latest code ==="
            git pull origin main

            echo "=== Installing dependencies ==="
            npm install --production

            echo "=== Restarting PM2 ==="
            pm2 restart ecosystem.config.cjs

            echo "=== Verifying ==="
            sleep 3
            curl -sf http://localhost:3000/health || echo "WARNING: Health check failed"

            echo "=== Deploy complete ==="
            pm2 status
```

> **`paths-ignore`**: Pushes that only change markdown files or sample storyboards won't trigger a deploy. Remove this if you want every push to deploy.

### How It Works

1. You push code (including `config/` changes) to `main`
2. GitHub Actions runs the workflow
3. It SSHs into your VM and runs:
   - `git pull` — pulls the latest code + config changes
   - `npm install` — installs any new/updated dependencies
   - `pm2 restart` — restarts the server and cleanup cron with the new code
   - Health check — verifies the server came back up
4. If health check fails, you'll see it in the Actions log

### Config Changes

Changes to `config/` (fonts, themes, etc.) are deployed the same way — they're part of the git repo. When `git pull` runs on the VM, the config files update and PM2 restart picks them up. No extra steps needed.

### Rollback

If a deploy breaks something:

```bash
# SSH into VM
gcloud compute ssh vcf-api --zone=us-central1-a

# Revert to previous commit
cd /opt/vcf
git log --oneline -5          # Find the last good commit
git checkout <commit-hash> -- .
pm2 restart ecosystem.config.cjs
```

Or revert the commit on GitHub and push — CI/CD will auto-deploy the revert.

### Manual Deploy (without CI/CD)

If you need to deploy without pushing to GitHub:

```bash
gcloud compute ssh vcf-api --zone=us-central1-a
cd /opt/vcf && git pull origin main && npm install && pm2 restart ecosystem.config.cjs
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
