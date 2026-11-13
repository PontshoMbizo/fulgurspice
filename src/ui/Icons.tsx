// 16 px toolbar glyphs: stroked, inherit the button colour.
const I = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={d} style={fill ? { fill: 'currentColor' } : undefined} /></svg>
);
export const IconRun = () => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="#fff" /></svg>;
export const IconStop = () => <I d="M4 4h8v8H4z" fill />;
export const IconUndo = () => <I d="M3 6h7a3.5 3.5 0 0 1 0 7H6M3 6l3-3M3 6l3 3" />;
export const IconRedo = () => <I d="M13 6H6a3.5 3.5 0 0 0 0 7h4M13 6l-3-3M13 6l-3 3" />;
export const IconSelect = () => <I d="M4 2l8 6.5-3.6.6 2 4-1.6.8-2-4L4 12.5z" />;
export const IconWire = () => <I d="M2 12h5V4h7M2 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0M14 4m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0" />;
export const IconProbe = () => <I d="M2 14l1.5-4.5L11 2l3 3-7.5 7.5zM9 4l3 3" />;
export const IconRotate = () => <I d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3" />;
export const IconMirror = () => <I d="M8 1.5v13M6 4L2 8l4 4zM10 4l4 4-4 4z" />;
export const IconDelete = () => <I d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" />;
export const IconFit = () => <I d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4M5.5 5.5h5v5h-5z" />;
