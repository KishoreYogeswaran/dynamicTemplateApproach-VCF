/**
 * Azure Blob Storage Uploader (JS port)
 *
 * Uploads local files to Azure Blob Storage and returns
 * time-bound SAS URLs for use with external APIs (WAN S2V, FIBO).
 */

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { getEnv } from '../utils/env.js';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from '@azure/storage-blob';

export class AzureMediaUploader {
  /**
   * @param {object} [opts]
   * @param {string} [opts.accountName]    — falls back to AZURE_ACCOUNT_NAME / AZURE_STORAGE_ACCOUNT_NAME
   * @param {string} [opts.accountKey]     — falls back to AZURE_ACCOUNT_KEY / AZURE_STORAGE_ACCOUNT_KEY
   * @param {string} [opts.containerName]  — falls back to AZURE_IMAGE_CONTAINER or "heygen-pipeline-images"
   * @param {string} [opts.domainName]     — optional domain prefix for blob namespacing
   */
  constructor(opts = {}) {
    this.accountName = opts.accountName
      || getEnv('AZURE_ACCOUNT_NAME')
      || getEnv('AZURE_STORAGE_ACCOUNT_NAME');

    this.accountKey = opts.accountKey
      || getEnv('AZURE_ACCOUNT_KEY')
      || getEnv('AZURE_STORAGE_ACCOUNT_KEY');

    this.containerName = opts.containerName
      || getEnv('AZURE_IMAGE_CONTAINER')
      || 'heygen-pipeline-images';

    this.domainName = opts.domainName || null;

    if (!this.accountName || !this.accountKey) {
      throw new Error(
        'Azure credentials not found. Set AZURE_ACCOUNT_NAME and AZURE_ACCOUNT_KEY in .env'
      );
    }

    this.credential = new StorageSharedKeyCredential(this.accountName, this.accountKey);
    this.serviceClient = new BlobServiceClient(
      `https://${this.accountName}.blob.core.windows.net`,
      this.credential,
    );
    this.containerClient = this.serviceClient.getContainerClient(this.containerName);
    this._containerEnsured = false;
  }

  async _ensureContainer() {
    if (this._containerEnsured) return;
    try {
      await this.containerClient.createIfNotExists();
    } catch {
      // Container already exists or permission issue — proceed anyway
    }
    this._containerEnsured = true;
  }

  /**
   * Upload a local file and return a public SAS URL.
   *
   * @param {object} opts
   * @param {string} opts.localPath    — absolute path to the local file
   * @param {string} [opts.sceneId]    — optional, used in blob name to avoid collisions
   * @param {string} [opts.contentType] — MIME type (e.g., "audio/mpeg", "image/png")
   * @param {number} [opts.expiryHours] — SAS URL expiry (default: 24 hours)
   * @returns {string} Public HTTPS SAS URL
   */
  async uploadFile({ localPath, sceneId, contentType, expiryHours = 24 }) {
    await this._ensureContainer();

    const fileName = basename(localPath);
    const parts = [];
    if (this.domainName) parts.push(this.domainName);
    if (sceneId) parts.push(sceneId);
    parts.push(`${Date.now()}_${fileName}`);
    const blobName = parts.join('/');

    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    const fileBuffer = await readFile(localPath);

    const uploadOpts = {};
    if (contentType) {
      uploadOpts.blobHTTPHeaders = { blobContentType: contentType };
    }

    await blockBlobClient.uploadData(fileBuffer, uploadOpts);

    // Generate SAS URL
    const expiresOn = new Date();
    expiresOn.setHours(expiresOn.getHours() + expiryHours);

    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: this.containerName,
        blobName,
        permissions: BlobSASPermissions.parse('r'),
        expiresOn,
      },
      this.credential,
    ).toString();

    const sasUrl = `${blockBlobClient.url}?${sasToken}`;
    console.log(`  [azure] Uploaded ${fileName} → ${blobName}`);
    return sasUrl;
  }
}
