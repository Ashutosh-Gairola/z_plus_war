/**
 * Proper color management for three r128 (what newer three.js does by
 * default with ColorManagement).
 *
 * Every color in this game is authored as an sRGB hex (0xRRGGBB, CSS-style).
 * Before, those numbers were fed to the renderer as if they were *linear*
 * light and written out unencoded — which is why everything looked flat and
 * "primary". Now:
 *   - hex / CSS colors are converted sRGB -> linear when set (and back when read),
 *   - canvas textures are tagged as sRGB,
 *   - the renderer outputs sRGB with filmic (ACES) tone mapping (see atmosphere.js).
 *
 * Import this FIRST (before anything creates a color or material).
 */

const C = THREE.Color.prototype;
if (!C.__colorManaged) {
  C.__colorManaged = true;

  const setHex = C.setHex;
  C.setHex = function setHexSRGB(hex) {
    setHex.call(this, hex);
    return this.convertSRGBToLinear();
  };

  const getHex = C.getHex;
  C.getHex = function getHexSRGB() {
    const linear = this.clone();
    linear.convertLinearToSRGB();
    return getHex.call(linear);
  };

  C.getHexString = function getHexStringSRGB() {
    return ("000000" + this.getHex().toString(16)).slice(-6);
  };

  const setStyle = C.setStyle;
  C.setStyle = function setStyleSRGB(style) {
    setStyle.call(this, style);
    return this.convertSRGBToLinear();
  };

  // Canvas-drawn textures hold sRGB pixels.
  const OrigCanvasTexture = THREE.CanvasTexture;
  THREE.CanvasTexture = class CanvasTextureSRGB extends OrigCanvasTexture {
    constructor(...args) {
      super(...args);
      this.encoding = THREE.sRGBEncoding;
    }
  };
}

export const COLOR_MANAGED = true;
