// The Annalo mark (vector of docs/brand/annalo-mark.svg); takes the current text color.

export function AnnaloLogo({ size = 24, className = "", title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 1000 1000" width={size} height={size} className={`annalo-logo ${className}`} role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <path fill="currentColor" fillRule="evenodd" d="M458.0,103.4 L491.0,160.1 L96.3,842.8 L256.8,842.8 L305.0,769.1 L235.1,769.1 L268.2,710.6 L687.4,710.6 L760.2,839.9 L902.7,839.9 L574.1,262.0 L535.4,327.2 L628.0,486.8 L502.4,689.8 L377.7,486.8 L574.1,145.9 L1000.0,896.6 L722.4,896.6 L647.8,769.1 L365.4,769.1 L289.9,896.6 L0.0,896.6 Z M502.4,382.0 L562.8,486.8 L502.4,582.2 L441.9,486.8 Z" />
    </svg>
  );
}
