export interface RasterPlacement {
  x: number
  y: number
  width: number
  height: number
}

const canonicalPreserveAspectRatio = (value: string) => (
  /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max) (?:meet|slice))$/.test(value)
    ? value
    : 'xMidYMid meet'
)

const positiveDimension = (value: number) => (
  Number.isFinite(value) && value > 0 ? value : 1
)

/**
 * Reproduces SVG image preserveAspectRatio in the image's local viewport,
 * before its outer affine transform. Coordinates are normalized to that
 * viewport so callers can use the result with Canvas, SVG, or Three.js.
 */
export const rasterPlacement = (
  pixelWidth: number,
  pixelHeight: number,
  viewportAspectRatio: number,
  preserve: string,
): RasterPlacement => {
  const canonical = canonicalPreserveAspectRatio(preserve)
  if (canonical === 'none') return { x: 0, y: 0, width: 1, height: 1 }

  const viewportAspect = positiveDimension(viewportAspectRatio)
  const imageAspect = positiveDimension(pixelWidth) / positiveDimension(pixelHeight)
  const [alignment, scaling = 'meet'] = canonical.split(' ')

  let width = 1
  let height = 1
  if (scaling === 'slice') {
    if (imageAspect >= viewportAspect) width = imageAspect / viewportAspect
    else height = viewportAspect / imageAspect
  } else if (imageAspect >= viewportAspect) {
    height = viewportAspect / imageAspect
  } else {
    width = imageAspect / viewportAspect
  }

  const x = alignment.startsWith('xMin') ? 0 : alignment.startsWith('xMax') ? 1 - width : (1 - width) / 2
  const y = alignment.includes('YMin') ? 0 : alignment.includes('YMax') ? 1 - height : (1 - height) / 2
  return { x, y, width, height }
}
