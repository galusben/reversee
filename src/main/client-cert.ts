// Reads the PEM client certificate + key configured for upstream mutual TLS.
// Only the paths are stored in settings; the key material stays in the user's
// files and is read when the proxy starts (or a request is replayed).
import fs from 'node:fs';
import type { AppSettings } from '../shared/settings-schema';

export interface ClientCert {
  cert: string;
  key: string;
}

/**
 * Returns undefined when no client certificate is configured. Throws with a
 * message naming the offending setting when one is configured but unusable —
 * silently proceeding without it would surface as a confusing TLS failure.
 */
export function readClientCert(
  settings: Pick<AppSettings, 'upstreamClientCertPath' | 'upstreamClientKeyPath'>
): ClientCert | undefined {
  const certPath = settings.upstreamClientCertPath.trim();
  const keyPath = settings.upstreamClientKeyPath.trim();
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) {
    throw new Error(
      'Upstream client certificate: both a certificate file and a key file are required'
    );
  }
  const read = (file: string, what: string, marker: RegExp): string => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(
        `Upstream client ${what}: cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`
      );
    }
    if (!marker.test(text)) {
      throw new Error(`Upstream client ${what}: ${file} is not a PEM ${what}`);
    }
    return text;
  };
  return {
    cert: read(certPath, 'certificate', /-----BEGIN CERTIFICATE-----/),
    key: read(keyPath, 'key', /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/),
  };
}
