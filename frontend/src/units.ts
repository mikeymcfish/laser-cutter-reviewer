export const MM_PER_INCH = 25.4

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const decimal = (value: number, maximumFractionDigits: number) => {
  const rounded = value.toFixed(maximumFractionDigits)
  return rounded.includes('.') ? rounded.replace(/0+$/, '').replace(/\.$/, '') : rounded
}

export const mmToInches = (value: unknown): number | null => {
  const millimeters = finiteNumber(value)
  return millimeters === null ? null : millimeters / MM_PER_INCH
}

export const formatInches = (
  valueMm: unknown,
  maximumFractionDigits = 3,
  fallback = '—',
): string => {
  const inches = mmToInches(valueMm)
  return inches === null ? fallback : `${decimal(inches, maximumFractionDigits)} in`
}

export const formatDimensionsInches = (
  widthMm: unknown,
  heightMm: unknown,
  maximumFractionDigits = 2,
  fallback = '—',
): string => {
  const width = mmToInches(widthMm)
  const height = mmToInches(heightMm)
  if (width === null || height === null) return fallback
  return `${decimal(width, maximumFractionDigits)} × ${decimal(height, maximumFractionDigits)} in`
}

export const formatSquareInches = (
  valueMm2: unknown,
  maximumFractionDigits = 3,
  fallback = '—',
): string => {
  const squareMillimeters = finiteNumber(valueMm2)
  if (squareMillimeters === null) return fallback
  return `${decimal(squareMillimeters / (MM_PER_INCH * MM_PER_INCH), maximumFractionDigits)} in²`
}

export const formatCutDensityInches = (
  valueMmPerMm2: unknown,
  maximumFractionDigits = 3,
  fallback = '—',
): string => {
  const density = finiteNumber(valueMmPerMm2)
  if (density === null) return fallback
  return `${decimal(density * MM_PER_INCH, maximumFractionDigits)} in/in²`
}
