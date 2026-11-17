import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { CopyBlock } from './ConnectAiDialog';

/** Setup help for "Capture anything" mode: how to point a client at the proxy. */
export function CaptureHowTo({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[600px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">
              Capture anything: connect a client
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="rounded p-1 text-neutral-500 hover:bg-neutral-100"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-neutral-600">
            Start the proxy, then set it as the HTTP and HTTPS proxy of the program you want to
            inspect. Every request that program makes shows up here, whichever server it goes to.
          </Dialog.Description>

          <div className="space-y-4 text-sm text-neutral-700">
            <CopyBlock
              label="1. Set the proxy. Most command-line tools and SDKs read these variables (some, like curl, only the lowercase http_proxy)"
              text={`export HTTP_PROXY=${address} http_proxy=${address}\nexport HTTPS_PROXY=${address} https_proxy=${address}`}
            />
            <CopyBlock
              label="2. Try it. With the variables from step 1 set, curl uses the proxy on its own"
              text="curl http://example.com/"
            />
            <CopyBlock
              label="Or skip the variables: -x (short for --proxy) sets the proxy for that one command"
              text={`curl -x ${address} http://example.com/`}
            />

            <div>
              <div className="mb-1 font-medium">3. HTTPS needs one more step</div>
              <p className="text-neutral-600">
                To show HTTPS traffic, Reversee answers with its own certificate, so the client has
                to trust the Reversee root certificate. Save it with{' '}
                <span className="font-medium">Proxy Settings → Export Root Cert</span>, then point
                the client at the file:
              </p>
            </div>
            <CopyBlock
              label="curl"
              text={`curl -x ${address} --cacert reversee.root.pem https://example.com/`}
            />
            <CopyBlock
              label="Node.js"
              text={`NODE_EXTRA_CA_CERTS=reversee.root.pem HTTPS_PROXY=${address} node --use-env-proxy app.js`}
            />
            <CopyBlock
              label="Python (requests, httpx)"
              text={`REQUESTS_CA_BUNDLE=reversee.root.pem SSL_CERT_FILE=reversee.root.pem HTTPS_PROXY=${address} python app.py`}
            />
            <p className="text-xs text-neutral-500">
              A client that does not trust the certificate appears in the table as a failed CONNECT
              row. Apps that pin their server&apos;s certificate cannot be inspected. Only trust the
              root certificate on machines you control: whoever holds its key can read that
              machine&apos;s HTTPS traffic.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
