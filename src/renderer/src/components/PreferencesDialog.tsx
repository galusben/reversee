import { useState } from 'react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { Modal, inputClass, secondaryButton } from './ui/Modal';
import {
  TRAFFIC_CAP_MAX,
  TRAFFIC_CAP_MIN,
  UPSTREAM_TIMEOUT_MAX_SEC,
  type AppSettings,
  type ThemeSetting,
} from '../../../shared/settings-schema';

/** A number field that only commits values inside [min, max]. */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const n = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(n) && n >= min && n <= max;
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      aria-invalid={!valid}
      title={valid ? label : `${label}: a whole number from ${min} to ${max}`}
      className={`w-24 ${inputClass} ${valid ? '' : 'border-red-500 bg-red-50'}`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isInteger(next) && next >= min && next <= max) {
          onCommit(next);
        }
      }}
    />
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      <div className="space-y-2 text-sm text-neutral-700">{children}</div>
    </section>
  );
}

function PathField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (path: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0">{label}</span>
      <input
        type="text"
        aria-label={label}
        placeholder="/path/to/file.pem"
        className={`min-w-0 grow font-mono ${inputClass}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className={secondaryButton}
        onClick={() =>
          void window.reversee.pickFile(`Choose the ${label.toLowerCase()}`).then((file) => {
            if (file) onChange(file);
          })
        }
      >
        Browse…
      </button>
    </div>
  );
}

export function PreferencesDialog(): React.JSX.Element | null {
  const open = useUiStore((s) => s.preferencesOpen);
  const setOpen = useUiStore((s) => s.setPreferencesOpen);
  const settings = useProxyStore((s) => s.settings);
  const running = useProxyStore((s) => s.running);
  const updateSettings = useProxyStore((s) => s.updateSettings);
  const certStatus = useProxyStore((s) => s.certStatus);
  const regenerateRootCert = useProxyStore((s) => s.regenerateRootCert);

  if (!settings) return null;
  const set = (patch: Partial<AppSettings>): void => void updateSettings(patch);

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title="Preferences"
      description={
        running
          ? 'Upstream settings take effect the next time the proxy starts.'
          : 'Appearance, history, and how Reversee talks to the upstream.'
      }
    >
      <Section title="Appearance">
        <label className="flex items-center gap-2">
          <span className="w-24">Theme</span>
          <select
            aria-label="Theme"
            className={inputClass}
            value={settings.theme}
            onChange={(e) => set({ theme: e.target.value as ThemeSetting })}
          >
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </Section>

      <Section title="History">
        <label className="flex items-center gap-2">
          <span>Keep the last</span>
          <NumberField
            label="History size"
            value={settings.trafficCap}
            min={TRAFFIC_CAP_MIN}
            max={TRAFFIC_CAP_MAX}
            onCommit={(trafficCap) => set({ trafficCap })}
          />
          <span>requests</span>
        </label>
      </Section>

      <Section title="Upstream">
        <label className="flex items-center gap-2">
          <span>Give up waiting for a response after</span>
          <NumberField
            label="Upstream timeout"
            value={settings.upstreamTimeoutSec}
            min={0}
            max={UPSTREAM_TIMEOUT_MAX_SEC}
            onCommit={(upstreamTimeoutSec) => set({ upstreamTimeoutSec })}
          />
          <span>seconds (0 = never)</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!settings.allowSelfSignedUpstream}
            onChange={(e) => set({ allowSelfSignedUpstream: !e.target.checked })}
          />
          Verify the upstream&apos;s TLS certificate
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.captureVerifyUpstream}
            onChange={(e) => set({ captureVerifyUpstream: e.target.checked })}
          />
          In Capture anything mode, verify the servers&apos; TLS certificates
        </label>
        <p className="text-xs text-neutral-500">
          Client certificate for upstreams that require mutual TLS (PEM files; only the paths are
          saved).
        </p>
        <PathField
          label="Certificate file"
          value={settings.upstreamClientCertPath}
          onChange={(upstreamClientCertPath) => set({ upstreamClientCertPath })}
        />
        <PathField
          label="Key file"
          value={settings.upstreamClientKeyPath}
          onChange={(upstreamClientKeyPath) => set({ upstreamClientKeyPath })}
        />
      </Section>

      <Section title="Root certificate">
        {certStatus && (
          <p
            className={certStatus.expired || certStatus.temporary ? 'text-red-600' : ''}
            aria-label="Root certificate status"
          >
            {certStatus.temporary
              ? `The saved root certificate could not be unlocked (${certStatus.temporaryReason}). A temporary one is in use.`
              : certStatus.expired
                ? `Expired on ${certStatus.notAfter.slice(0, 10)}. HTTPS clients will reject the proxy.`
                : `Valid until ${certStatus.notAfter.slice(0, 10)} (${certStatus.daysLeft} days left).`}
          </p>
        )}
        <button type="button" className={secondaryButton} onClick={() => void regenerateRootCert()}>
          Regenerate root certificate…
        </button>
      </Section>
    </Modal>
  );
}
