// A message pinned to the top of the screen, so it is seen wherever the page is scrolled.

import { useEffect, useRef, useState } from 'preact/hooks';

export interface ToastData {
  id: number;
  text: string;
}

const LIFETIME_MS = 15_000;

export function useToast() {
  const [toast, setToast] = useState<ToastData | null>(null);
  const counter = useRef(0);
  return {
    toast,
    show(text: string) {
      setToast({ id: ++counter.current, text });
      // Browsers refuse to vibrate until the visitor has tapped the page, and log a warning if asked.
      try {
        if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(60);
      } catch {
        /* not supported */
      }
    },
    dismiss() {
      setToast(null);
    },
  };
}

/**
 * The wrapper is always in the page so screen readers announce what appears inside it.
 * The toast stays for 15 seconds, and for as long as it is being touched, hovered or focused.
 */
export function Toast(props: { toast: ToastData | null; onDismiss(): void }) {
  const { toast, onDismiss } = props;
  const [held, setHeld] = useState(false);

  useEffect(() => {
    setHeld(false);
  }, [toast?.id]);

  useEffect(() => {
    if (!toast || held) return;
    const timer = setTimeout(onDismiss, LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [toast?.id, held]);

  return (
    <div class="toast-wrap" role="status" aria-live="polite">
      {toast && (
        <div
          class="toast"
          key={toast.id}
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocusIn={() => setHeld(true)}
          onFocusOut={() => setHeld(false)}
        >
          <span class="toast-emoji" aria-hidden="true">
            🙏
          </span>
          <span class="toast-text">{toast.text}</span>
          <button class="toast-close" aria-label="Dismiss notification" onClick={onDismiss}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
    </div>
  );
}
