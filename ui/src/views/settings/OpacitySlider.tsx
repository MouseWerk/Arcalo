// The opacity slider of the window backdrop (Settings → Darstellung „Deckkraft“): applies while
// dragged (nothing saved yet), saves once let go.
//
// The thumb belongs to the browser (the input is not controlled): WebKit runs pending work, such
// as a settings save that just finished and its render, between the listeners of one event. A
// controlled input rendered there put the thumb back before React's change handler saw the move,
// and the release saved the old value. The release saves what the slider shows.

import { useEffect, useRef, useState } from "react";
import { OPACITY_MIN, previewOpacity } from "../../lib/backdrop";

export function OpacitySlider({ value, disabled, label, onCommit }: { value: number; disabled: boolean; label: string; onCommit: (v: number) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(value);
  // A value saved elsewhere (undo, another window, the start) moves the thumb.
  useEffect(() => {
    setV(value);
    if (input.current) input.current.value = String(value);
  }, [value]);
  const live = (n: number) => {
    setV(n);
    previewOpacity(n);
  };
  const commit = () => {
    const n = Number(input.current?.value ?? v);
    if (n !== v) live(n);
    if (n !== value) onCommit(n);
  };
  const fill = ((v - OPACITY_MIN) / (100 - OPACITY_MIN)) * 100;
  return (
    <span className={`opacity-slider ${disabled ? "off" : ""}`}>
      <input
        ref={input}
        type="range"
        min={OPACITY_MIN}
        max={100}
        step={1}
        defaultValue={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={`${v} %`}
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
        onChange={(e) => live(Number(e.currentTarget.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <output className="opacity-value num">{v} %</output>
    </span>
  );
}
