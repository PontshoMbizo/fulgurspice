// Toolbar and panel glyphs: Lucide icons (https://lucide.dev, ISC licence, v1.8.0),
// inlined so the editor needs no icon dependency. 24-unit grid, stroked in currentColor.
// Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
// All other copyright (c) for Lucide are held by Lucide Contributors 2022.

import { createElement } from 'react';

type Node = [string, Record<string, string>][];
export interface IconProps { size?: number; className?: string }

function L({ n, size = 15, className }: IconProps & { n: Node }) {
  return (
    <svg className={className ? `lucide ${className}` : 'lucide'} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {n.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

const nRun: Node = [["path",{"d":"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"}]];
export const IconRun = (p: IconProps) => <L n={nRun} {...p} />;
const nStop: Node = [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}]];
export const IconStop = (p: IconProps) => <L n={nStop} {...p} />;
const nUndo: Node = [["path",{"d":"M9 14 4 9l5-5"}],["path",{"d":"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"}]];
export const IconUndo = (p: IconProps) => <L n={nUndo} {...p} />;
const nRedo: Node = [["path",{"d":"m15 14 5-5-5-5"}],["path",{"d":"M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"}]];
export const IconRedo = (p: IconProps) => <L n={nRedo} {...p} />;
const nSelect: Node = [["path",{"d":"M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"}]];
export const IconSelect = (p: IconProps) => <L n={nSelect} {...p} />;
const nWire: Node = [["circle",{"cx":"19","cy":"5","r":"2"}],["circle",{"cx":"5","cy":"19","r":"2"}],["path",{"d":"M5 17A12 12 0 0 1 17 5"}]];
export const IconWire = (p: IconProps) => <L n={nWire} {...p} />;
const nProbe: Node = [["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"22","x2":"18","y1":"12","y2":"12"}],["line",{"x1":"6","x2":"2","y1":"12","y2":"12"}],["line",{"x1":"12","x2":"12","y1":"6","y2":"2"}],["line",{"x1":"12","x2":"12","y1":"22","y2":"18"}]];
export const IconProbe = (p: IconProps) => <L n={nProbe} {...p} />;
const nRotate: Node = [["path",{"d":"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}]];
export const IconRotate = (p: IconProps) => <L n={nRotate} {...p} />;
const nMirror: Node = [["path",{"d":"m3 7 5 5-5 5V7"}],["path",{"d":"m21 7-5 5 5 5V7"}],["path",{"d":"M12 20v2"}],["path",{"d":"M12 14v2"}],["path",{"d":"M12 8v2"}],["path",{"d":"M12 2v2"}]];
export const IconMirror = (p: IconProps) => <L n={nMirror} {...p} />;
const nDelete: Node = [["path",{"d":"M10 11v6"}],["path",{"d":"M14 11v6"}],["path",{"d":"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"}],["path",{"d":"M3 6h18"}],["path",{"d":"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}]];
export const IconDelete = (p: IconProps) => <L n={nDelete} {...p} />;
const nFit: Node = [["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}]];
export const IconFit = (p: IconProps) => <L n={nFit} {...p} />;
const nPanelLeft: Node = [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]];
export const IconPanelLeft = (p: IconProps) => <L n={nPanelLeft} {...p} />;
const nPanelRight: Node = [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M15 3v18"}]];
export const IconPanelRight = (p: IconProps) => <L n={nPanelRight} {...p} />;
const nCircuitBoard: Node = [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M11 9h4a2 2 0 0 0 2-2V3"}],["circle",{"cx":"9","cy":"9","r":"2"}],["path",{"d":"M7 21v-4a2 2 0 0 1 2-2h4"}],["circle",{"cx":"15","cy":"15","r":"2"}]];
export const IconCircuitBoard = (p: IconProps) => <L n={nCircuitBoard} {...p} />;
const nSlidersHorizontal: Node = [["path",{"d":"M10 5H3"}],["path",{"d":"M12 19H3"}],["path",{"d":"M14 3v4"}],["path",{"d":"M16 17v4"}],["path",{"d":"M21 12h-9"}],["path",{"d":"M21 19h-5"}],["path",{"d":"M21 5h-7"}],["path",{"d":"M8 10v4"}],["path",{"d":"M8 12H3"}]];
export const IconSlidersHorizontal = (p: IconProps) => <L n={nSlidersHorizontal} {...p} />;
const nActivity: Node = [["path",{"d":"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"}]];
export const IconActivity = (p: IconProps) => <L n={nActivity} {...p} />;
const nTerminal: Node = [["path",{"d":"M12 19h8"}],["path",{"d":"m4 17 6-6-6-6"}]];
export const IconTerminal = (p: IconProps) => <L n={nTerminal} {...p} />;
const nFileText: Node = [["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 9H8"}],["path",{"d":"M16 13H8"}],["path",{"d":"M16 17H8"}]];
export const IconFileText = (p: IconProps) => <L n={nFileText} {...p} />;
const nRuler: Node = [["path",{"d":"M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"}],["path",{"d":"m14.5 12.5 2-2"}],["path",{"d":"m11.5 9.5 2-2"}],["path",{"d":"m8.5 6.5 2-2"}],["path",{"d":"m17.5 15.5 2-2"}]];
export const IconRuler = (p: IconProps) => <L n={nRuler} {...p} />;
const nCircleCheck: Node = [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m9 12 2 2 4-4"}]];
export const IconCircleCheck = (p: IconProps) => <L n={nCircleCheck} {...p} />;
const nCircleAlert: Node = [["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]];
export const IconCircleAlert = (p: IconProps) => <L n={nCircleAlert} {...p} />;
const nChevronDown: Node = [["path",{"d":"m6 9 6 6 6-6"}]];
export const IconChevronDown = (p: IconProps) => <L n={nChevronDown} {...p} />;
const nX: Node = [["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]];
export const IconX = (p: IconProps) => <L n={nX} {...p} />;
const nMinus: Node = [["path",{"d":"M5 12h14"}]];
export const IconMinus = (p: IconProps) => <L n={nMinus} {...p} />;
const nPlus: Node = [["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]];
export const IconPlus = (p: IconProps) => <L n={nPlus} {...p} />;
const nSearch: Node = [["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]];
export const IconSearch = (p: IconProps) => <L n={nSearch} {...p} />;
const nLibrary: Node = [["path",{"d":"m16 6 4 14"}],["path",{"d":"M12 6v14"}],["path",{"d":"M8 8v12"}],["path",{"d":"M4 4v16"}]];
export const IconLibrary = (p: IconProps) => <L n={nLibrary} {...p} />;
const nMaximize2: Node = [["path",{"d":"M15 3h6v6"}],["path",{"d":"m21 3-7 7"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M9 21H3v-6"}]];
export const IconMaximize2 = (p: IconProps) => <L n={nMaximize2} {...p} />;
const nMinimize2: Node = [["path",{"d":"m14 10 7-7"}],["path",{"d":"M20 10h-6V4"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M4 14h6v6"}]];
export const IconMinimize2 = (p: IconProps) => <L n={nMinimize2} {...p} />;
