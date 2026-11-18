'use strict';
/**
 * Pure geometry conversions (zero dependencies; directly testable in pure Node/CI environments).
 *
 * Electron screen / BrowserWindow coordinates are always in DIPs (Device Independent Pixels),
 * while the window agent agent.ps1 declares per-monitor v2 DPI awareness, where Win32 SetWindowPos
 * expects physical pixels. Mixing the two under 125% / 150% scaling causes windows to appear half-sized,
 * offset, or misaligned (issue #99). This module standardizes the physical conversion.
 */

/**
 * Converts a DIP rectangle to physical pixels.
 * @param {{x:number,y:number,w:number,h:number}} rect DIP logical rectangle
 * @param {number} [scaleFactor] Scale factor; returns original object if 1 or unspecified (zero overhead)
 * @returns {{x:number,y:number,w:number,h:number}} Physical pixel rectangle
 */
function physicalRect(rect, scaleFactor) {
  const k = Number(scaleFactor) || 1;
  if (!rect || k === 1) return rect;
  return {
    x: Math.round(rect.x * k),
    y: Math.round(rect.y * k),
    w: Math.round(rect.w * k),
    h: Math.round(rect.h * k),
  };
}

module.exports = { physicalRect };
