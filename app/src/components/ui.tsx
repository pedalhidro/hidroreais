import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import QRCode from "qrcode";
import QrScanner from "qr-scanner";

export function Screen(props: { title?: string; back?: string; children: ComponentChildren }) {
  return (
    <main class="screen">
      {(props.title || props.back) && (
        <header class="screen-head">
          {props.back && (
            <a class="back" href={`#${props.back}`} aria-label="Voltar">
              ‹
            </a>
          )}
          {props.title && <h1>{props.title}</h1>}
        </header>
      )}
      {props.children}
    </main>
  );
}

export function Notice(props: { tone?: "error" | "info" | "ok"; children: ComponentChildren }) {
  return (
    <p class={`notice notice-${props.tone ?? "info"}`} role={props.tone === "error" ? "alert" : "status"}>
      {props.children}
    </p>
  );
}

export function QR(props: { value: string; label: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(props.value, { margin: 1, width: 480, color: { dark: "#13204f", light: "#ffffff" } }).then(setSrc);
  }, [props.value]);
  return <figure class="qr">{src && <img src={src} alt={props.label} width={240} height={240} />}</figure>;
}

/** Camera QR scanner. Calls onResult once with the decoded text. */
export function Scanner(props: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!video.current) return;
    let done = false;
    const scanner = new QrScanner(
      video.current,
      (r) => {
        if (done) return;
        done = true;
        scanner.stop();
        props.onResult(r.data);
      },
      { preferredCamera: "environment", highlightScanRegion: true, returnDetailedScanResult: true },
    );
    scanner.start().catch(() => setError("Não foi possível abrir a câmera. Permita o acesso à câmera e tente de novo."));
    return () => scanner.destroy();
  }, []);
  return (
    <div class="scanner">
      <video ref={video} playsInline muted />
      {error && <Notice tone="error">{error}</Notice>}
      <button class="btn btn-quiet" onClick={props.onClose}>
        Fechar câmera
      </button>
    </div>
  );
}

export function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      class="btn btn-quiet"
      onClick={async () => {
        await navigator.clipboard.writeText(props.text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
    >
      {copied ? "Copiado" : (props.label ?? "Copiar link")}
    </button>
  );
}

export function ShareButton(props: { text: string; title: string }) {
  // Always shown next to a CopyButton, so there is nothing to add where sharing is unsupported.
  if (!("share" in navigator)) return null;
  return (
    <button class="btn btn-quiet" onClick={() => navigator.share({ title: props.title, url: props.text }).catch(() => {})}>
      Compartilhar
    </button>
  );
}
