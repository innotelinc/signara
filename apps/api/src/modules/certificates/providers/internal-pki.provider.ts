import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CertificateProvider, CertificateProvisionInput, IssuedCertificate } from './provider.interface';

const execFileAsync = promisify(execFile);

interface ScriptResult {
  certificatePem: string;
  chainPem?: string;
  privateKeyPem?: string;
  sourceRef?: string;
  keyAlgorithm?: string;
  validationLevel?: string;
}

/**
 * Enterprise PKI / internal CA integration.
 *
 * Two modes:
 *  1. Import (default) — administrators upload an existing certificate
 *     (optionally with its private key) via POST /certificates/import. The
 *     private key is encrypted at rest with CRYPTO_MASTER_KEY and signing is
 *     performed server-side.
 *  2. Provision script — set INTERNAL_PKI_PROVISION_SCRIPT to a trusted
 *     executable (your corporate CA CLI / step-ca / cert-manager helper) that
 *     accepts `--common-name <cn> --email <email>` and prints the JSON
 *     contract below on stdout:
 *
 *       {
 *         "certificatePem": "...",
 *         "chainPem": "...",          // optional
 *         "privateKeyPem": "...",     // optional
 *         "sourceRef": "...",         // optional
 *         "keyAlgorithm": "RSA-2048", // optional
 *         "validationLevel": "OV"     // optional
 *       }
 *
 * The script runs with a hard 30s timeout and its stderr is captured for
 * diagnostics. NEVER route untrusted input to the script path.
 */
@Injectable()
export class InternalPkiProvider implements CertificateProvider {
  readonly kind = 'INTERNAL_PKI' as const;
  private readonly logger = new Logger(InternalPkiProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get scriptPath(): string | undefined {
    return this.config.get<string>('INTERNAL_PKI_PROVISION_SCRIPT');
  }

  isConfigured(): boolean {
    // Import-only deployments are always "configured"; scripted provisioning
    // is optional on top.
    return true;
  }

  async provision(input: CertificateProvisionInput): Promise<IssuedCertificate> {
    const script = this.scriptPath;
    if (!script) {
      throw new Error(
        'No internal CA provisioner configured (INTERNAL_PKI_PROVISION_SCRIPT). Import an existing certificate via POST /certificates/import instead.',
      );
    }

    this.logger.log(`Provisioning via internal PKI script for ${input.commonName}`);
    const { stdout, stderr } = await execFileAsync(
      script,
      ['--common-name', input.commonName, '--email', input.email ?? ''],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );

    if (stderr) this.logger.warn(`Internal PKI script stderr: ${stderr.slice(0, 500)}`);

    let result: ScriptResult;
    try {
      result = JSON.parse(stdout) as ScriptResult;
    } catch {
      throw new Error('Internal PKI script did not return valid JSON on stdout');
    }
    if (!result.certificatePem?.includes('BEGIN CERTIFICATE')) {
      throw new Error('Internal PKI script response missing certificatePem');
    }

    return {
      certificatePem: result.certificatePem,
      chainPem: result.chainPem,
      privateKeyPem: result.privateKeyPem,
      sourceRef: result.sourceRef ?? `internal-pki:${input.commonName}`,
      keyAlgorithm: result.keyAlgorithm,
      validationLevel: result.validationLevel ?? 'OV',
    };
  }
}