import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type {
  AnalysisCheck,
  Point,
  PreviewGeometry,
  PreviewPiece,
  PreviewRasterAsset,
  PreviewRasterLayer,
  PreviewWeakPoint,
} from '../types'
import { rasterPlacement as calculateRasterPlacement } from '../rasterPlacement'
import { formatInches } from '../units'

interface Preview3DProps {
  geometry: PreviewGeometry
  materialType: string
  thicknessMm: number
  kerfMm: number
  previewAppearance?: {
    color?: string
    opacity?: number
    roughness?: number
  }
  showWeakPoints?: boolean
  selectedCheck?: AnalysisCheck
}

const bounds = (points: Point[]) => {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  }
}

interface RenderableRasterLayer {
  layer: PreviewRasterLayer
  asset: PreviewRasterAsset
  sequence: number
}

interface RasterSurfaceLayer extends RenderableRasterLayer {
  material: THREE.ShaderMaterial
  layerBounds: ReturnType<typeof bounds>
  order: number
}

const canonicalPng = (value: string) => (
  /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  && value.length <= 8 * 1024 * 1024
)

const finiteCorners = (corners: Point[]) => {
  if (corners.length !== 4 || !corners.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return false
  const [topLeft, topRight, , bottomLeft] = corners
  const axisX: Point = [topRight[0] - topLeft[0], topRight[1] - topLeft[1]]
  const axisY: Point = [bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]]
  return Math.abs(axisX[0] * axisY[1] - axisX[1] * axisY[0]) > 1e-8
}

const finitePoint = (point: Point | undefined): point is Point => (
  Boolean(point) && point!.length === 2 && point!.every((value) => Number.isFinite(value))
)

export const renderableWeakPoints = (geometry: PreviewGeometry): PreviewWeakPoint[] => (
  (geometry.weak_points?.points ?? []).filter((point) => (
    finitePoint(point.location_mm)
    && Number.isFinite(point.measurement)
    && Number.isFinite(point.threshold)
    && point.measurement >= 0
    && point.threshold > 0
    && (!point.span_mm || (point.span_mm.length === 2 && point.span_mm.every(finitePoint)))
  ))
)

const weakPointColor = (kind: PreviewWeakPoint['kind']) => {
  if (kind === 'tiny_piece') return '#8b4ac7'
  if (kind === 'close_cut_spacing') return '#db7a16'
  return '#d44d38'
}

const numberedMarkerTexture = (index: number, color: string) => {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const context = canvas.getContext('2d')
  if (!context) return null

  context.clearRect(0, 0, canvas.width, canvas.height)
  context.beginPath()
  context.arc(48, 48, 40, 0, Math.PI * 2)
  context.fillStyle = color
  context.fill()
  context.lineWidth = 6
  context.strokeStyle = '#ffffff'
  context.stroke()
  const label = String(index)
  context.fillStyle = '#ffffff'
  context.font = `800 ${label.length > 2 ? 31 : label.length > 1 ? 39 : 46}px system-ui, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(label, 48, 50)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.name = `Weak point ${index}`
  return texture
}

export const renderableRasterLayers = (geometry: PreviewGeometry): RenderableRasterLayer[] => {
  const assets = new Map(
    (geometry.raster_assets ?? [])
      .filter((asset) => canonicalPng(asset.data_url))
      .map((asset) => [asset.id, asset]),
  )
  return (geometry.raster_layers ?? [])
    .map((layer, index) => ({ layer, asset: assets.get(layer.asset_id), sequence: geometry.paths.length + index }))
    .filter((item): item is RenderableRasterLayer => (
      item.layer.blend_mode === 'multiply'
      && finiteCorners(item.layer.corners_mm)
      && Boolean(item.asset)
    ))
    .sort((left, right) => {
      const leftZ = Number.isFinite(left.layer.z_index) ? left.layer.z_index : left.sequence
      const rightZ = Number.isFinite(right.layer.z_index) ? right.layer.z_index : right.sequence
      return leftZ - rightZ || left.sequence - right.sequence
    })
}

export const rasterPlacement = (asset: PreviewRasterAsset, preserve: string, viewportAspectRatio: number) => (
  calculateRasterPlacement(
    Number(asset.preview_width_px) || Number(asset.pixel_width) || 1,
    Number(asset.preview_height_px) || Number(asset.pixel_height) || 1,
    viewportAspectRatio,
    preserve,
  )
)

const intersects = (left: ReturnType<typeof bounds>, right: ReturnType<typeof bounds>) => (
  left.maxX >= right.minX
  && left.minX <= right.maxX
  && left.maxY >= right.minY
  && left.minY <= right.maxY
)

const pointOnSegment = (point: Point, start: Point, end: Point) => {
  const cross = (point[0] - start[0]) * (end[1] - start[1]) - (point[1] - start[1]) * (end[0] - start[0])
  if (Math.abs(cross) > 1e-7) return false
  return point[0] >= Math.min(start[0], end[0]) - 1e-7
    && point[0] <= Math.max(start[0], end[0]) + 1e-7
    && point[1] >= Math.min(start[1], end[1]) - 1e-7
    && point[1] <= Math.max(start[1], end[1]) + 1e-7
}

const pointInLoop = (point: Point, loop: Point[]) => {
  if (loop.length < 3) return false
  let inside = false
  for (let index = 0, previous = loop.length - 1; index < loop.length; previous = index++) {
    const start = loop[previous]
    const end = loop[index]
    if (pointOnSegment(point, start, end)) return true
    if (
      (start[1] > point[1]) !== (end[1] > point[1])
      && point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0]
    ) inside = !inside
  }
  return inside
}

const pieceContainsPoint = (piece: PreviewPiece, point: Point) => (
  pointInLoop(point, piece.outer)
  && !(piece.holes ?? []).some((hole) => pointInLoop(point, hole))
)

const layerRenderOrder = (zIndex: number, sequence: number) => (
  1_000 + Math.max(0, Number.isFinite(zIndex) ? zIndex : sequence) + sequence * 1e-6
)

const addLoop = (target: THREE.Shape | THREE.Path, points: Point[], pageHeight: number) => {
  const first = points[0]
  if (!first) return
  target.moveTo(first[0], pageHeight - first[1])
  points.slice(1).forEach(([x, y]) => target.lineTo(x, pageHeight - y))
  target.closePath()
}

const disposeObject = (
  object: THREE.Object3D,
  additionalMaterials: Iterable<THREE.Material> = [],
  additionalTextures: Iterable<THREE.Texture> = [],
) => {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>(additionalMaterials)
  const textures = new Set<THREE.Texture>(additionalTextures)
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Sprite) {
      if (child.geometry) geometries.add(child.geometry)
      const material = child.material as THREE.Material | THREE.Material[]
      if (Array.isArray(material)) material.forEach((item) => materials.add(item))
      else if (material) materials.add(material)
    }
  })
  materials.forEach((material) => {
    Object.values(material).forEach((value) => {
      if (value instanceof THREE.Texture) textures.add(value)
    })
    if (material instanceof THREE.ShaderMaterial) {
      Object.values(material.uniforms).forEach((uniform) => {
        if (uniform?.value instanceof THREE.Texture) textures.add(uniform.value)
      })
    }
  })
  geometries.forEach((geometry) => geometry.dispose())
  textures.forEach((texture) => texture.dispose())
  materials.forEach((material) => material.dispose())
}

export function Preview3D({
  geometry,
  materialType,
  thicknessMm,
  kerfMm,
  previewAppearance,
  showWeakPoints = false,
  selectedCheck,
}: Preview3DProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewStateRef = useRef<{
    geometry: PreviewGeometry
    camera: [number, number, number]
    target: [number, number, number]
  } | null>(null)
  const [exploded, setExploded] = useState(false)
  const [showSheetReference, setShowSheetReference] = useState(true)
  const [renderError, setRenderError] = useState('')
  const isAcrylic = materialType.toLowerCase().includes('acrylic')
  const previewColor = previewAppearance?.color ?? (isAcrylic ? '#72c4dc' : '#c89a62')
  const previewOpacity = Math.min(1, Math.max(0, previewAppearance?.opacity ?? (isAcrylic ? 0.78 : 1)))
  const previewRoughness = Math.min(1, Math.max(0, previewAppearance?.roughness ?? (isAcrylic ? 0.12 : 0.72)))
  const rasterLayerCount = renderableRasterLayers(geometry).length
  const weakPoints = useMemo(() => renderableWeakPoints(geometry), [geometry.weak_points])
  const effectiveExploded = exploded && !showWeakPoints

  useEffect(() => {
    if (showWeakPoints) setExploded(false)
  }, [showWeakPoints])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !geometry.valid_3d) return
    setRenderError('')
    let animationFrame = 0
    let renderer: THREE.WebGLRenderer | undefined
    let controls: OrbitControls | undefined
    let resizeObserver: ResizeObserver | undefined
    let resourcesActive = true
    const sceneObjects = new THREE.Group()
    const rasterMaterials = new Set<THREE.ShaderMaterial>()
    const rasterTextures = new Set<THREE.Texture>()

    try {
      const pageWidth = Number(geometry.page.width_mm) || 1
      const pageHeight = Number(geometry.page.height_mm) || 1
      const width = Math.max(host.clientWidth, 300)
      const height = Math.max(host.clientHeight, 360)
      const maxDimension = Math.max(pageWidth, pageHeight, 50)
      const scene = new THREE.Scene()
      scene.background = new THREE.Color('#edf0f4')
      scene.fog = new THREE.Fog('#edf0f4', maxDimension * 1.5, maxDimension * 4)

      const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 5000)
      camera.position.set(maxDimension * 0.72, -maxDimension * 0.92, maxDimension * 0.95)

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(width, height)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      host.replaceChildren(renderer.domElement)

      controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.06
      const savedView = viewStateRef.current
      if (savedView?.geometry === geometry) {
        camera.position.set(...savedView.camera)
        controls.target.set(...savedView.target)
      } else {
        controls.target.set(0, 0, 0)
      }
      controls.minDistance = maxDimension * 0.35
      controls.maxDistance = maxDimension * 4

      scene.add(new THREE.HemisphereLight('#f6f8ff', '#5b4b39', 2.4))
      const keyLight = new THREE.DirectionalLight('#fff8e8', 3.2)
      keyLight.position.set(-maxDimension, -maxDimension, maxDimension * 1.7)
      keyLight.castShadow = true
      scene.add(keyLight)
      const rimLight = new THREE.DirectionalLight('#a8c5ff', 1.4)
      rimLight.position.set(maxDimension, maxDimension, maxDimension)
      scene.add(rimLight)

      const thickness = Math.max(Number(thicknessMm) || 3, 0.5)
      const bevelThickness = Math.min(0.16, thickness * 0.05)
      const topSurfaceZ = thickness + bevelThickness
      const surfaceOverlayGap = 0.04
      const centerX = pageWidth / 2
      const centerY = pageHeight / 2
      const pieceTransforms = geometry.pieces.map((piece, index) => {
        const position = new THREE.Vector3()
        if (effectiveExploded) {
          const pieceBounds = bounds(piece.outer)
          const pieceX = (pieceBounds.minX + pieceBounds.maxX) / 2 - centerX
          const pieceY = centerY - (pieceBounds.minY + pieceBounds.maxY) / 2
          const length = Math.hypot(pieceX, pieceY) || 1
          const spread = maxDimension * (0.045 + (index % 3) * 0.009)
          position.set((pieceX / length) * spread, (pieceY / length) * spread, index * thickness * 0.12)
        }
        return { piece, position }
      })
      const transformForPoint = (point: Point) => (
        pieceTransforms.find(({ piece }) => pieceContainsPoint(piece, point))?.position
      )
      const rasterLayers = renderableRasterLayers(geometry)
      const textureLoader = new THREE.TextureLoader()
      const rasterSurfaces: RasterSurfaceLayer[] = rasterLayers.map((item, order) => {
        let material: THREE.ShaderMaterial | undefined
        const texture = textureLoader.load(
          item.asset.data_url,
          undefined,
          undefined,
          () => {
            if (resourcesActive && material) material.visible = false
          },
        )
        texture.colorSpace = THREE.SRGBColorSpace
        texture.wrapS = THREE.ClampToEdgeWrapping
        texture.wrapT = THREE.ClampToEdgeWrapping
        texture.minFilter = THREE.LinearFilter
        texture.magFilter = THREE.LinearFilter
        rasterTextures.add(texture)

        const [topLeft, topRight, , bottomLeft] = item.layer.corners_mm
        const origin = new THREE.Vector2(topLeft[0] - centerX, pageHeight - topLeft[1] - centerY)
        const axisX = new THREE.Vector2(topRight[0] - topLeft[0], topLeft[1] - topRight[1])
        const axisY = new THREE.Vector2(bottomLeft[0] - topLeft[0], topLeft[1] - bottomLeft[1])
        const placement = rasterPlacement(
          item.asset,
          item.layer.preserve_aspect_ratio,
          item.layer.viewport_aspect_ratio,
        )
        material = new THREE.ShaderMaterial({
          uniforms: {
            imageMap: { value: texture },
            layerOpacity: {
              value: Number.isFinite(item.layer.opacity) ? Math.min(1, Math.max(0, item.layer.opacity)) : 1,
            },
            rasterOrigin: { value: origin },
            rasterAxisX: { value: axisX },
            rasterAxisY: { value: axisY },
            imagePlacement: {
              value: new THREE.Vector4(placement.x, placement.y, placement.width, placement.height),
            },
          },
          vertexShader: `
            varying vec2 rasterPosition;
            void main() {
              rasterPosition = position.xy;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform sampler2D imageMap;
            uniform float layerOpacity;
            uniform vec2 rasterOrigin;
            uniform vec2 rasterAxisX;
            uniform vec2 rasterAxisY;
            uniform vec4 imagePlacement;
            varying vec2 rasterPosition;

            void main() {
              vec2 delta = rasterPosition - rasterOrigin;
              float determinant = rasterAxisX.x * rasterAxisY.y - rasterAxisX.y * rasterAxisY.x;
              vec2 viewport = vec2(
                (delta.x * rasterAxisY.y - delta.y * rasterAxisY.x) / determinant,
                (rasterAxisX.x * delta.y - rasterAxisX.y * delta.x) / determinant
              );
              if (viewport.x < 0.0 || viewport.x > 1.0 || viewport.y < 0.0 || viewport.y > 1.0) discard;

              vec2 imagePosition = (viewport - imagePlacement.xy) / imagePlacement.zw;
              if (imagePosition.x < 0.0 || imagePosition.x > 1.0 || imagePosition.y < 0.0 || imagePosition.y > 1.0) discard;

              vec4 texel = texture2D(imageMap, vec2(imagePosition.x, 1.0 - imagePosition.y));
              float strength = clamp(texel.a * layerOpacity, 0.0, 1.0);
              gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, strength), 1.0);
              #include <colorspace_fragment>
            }
          `,
          transparent: true,
          blending: THREE.MultiplyBlending,
          depthWrite: false,
          depthTest: true,
          side: THREE.DoubleSide,
          toneMapped: false,
        })
        material.name = `Embedded raster ${item.layer.id}`
        rasterMaterials.add(material)
        return {
          ...item,
          material,
          layerBounds: bounds(item.layer.corners_mm),
          order,
        }
      })

      if (showSheetReference) {
        const sheetDepth = Math.max(thickness * 0.12, 0.35)
        const offcutGeometry = new THREE.BoxGeometry(pageWidth, pageHeight, sheetDepth)
        const offcutMaterial = new THREE.MeshStandardMaterial({
          color: previewColor,
          roughness: previewRoughness,
          metalness: 0,
          transparent: true,
          opacity: Math.min(previewOpacity, 0.2),
        })
        const offcut = new THREE.Mesh(offcutGeometry, offcutMaterial)
        offcut.position.z = -Math.max(thickness * 0.22, 0.5)
        offcut.receiveShadow = true
        sceneObjects.add(offcut)

        const referenceSurfaceZ = offcut.position.z + sheetDepth / 2 + surfaceOverlayGap
        rasterSurfaces.forEach((raster) => {
          const imageSurface = new THREE.Mesh(
            new THREE.PlaneGeometry(pageWidth, pageHeight),
            raster.material,
          )
          imageSurface.position.z = referenceSurfaceZ + raster.order * 0.002
          imageSurface.renderOrder = layerRenderOrder(raster.layer.z_index, raster.sequence)
          imageSurface.userData.previewRasterLayerId = raster.layer.id
          imageSurface.userData.previewRasterSurface = 'sheet-reference'
          sceneObjects.add(imageSurface)
        })
      }

      geometry.pieces.forEach((piece, index) => {
        if (piece.outer.length < 3) return
        const shape = new THREE.Shape()
        // The analyzer has already offset normalized piece polygons by half the
        // configured kerf. Reusing those coordinates avoids applying kerf twice.
        addLoop(shape, piece.outer, pageHeight)
        ;(piece.holes ?? []).forEach((holePoints) => {
          if (holePoints.length < 3) return
          const hole = new THREE.Path()
          addLoop(hole, holePoints, pageHeight)
          shape.holes.push(hole)
        })
        const extrude = new THREE.ExtrudeGeometry(shape, {
          depth: thickness,
          bevelEnabled: true,
          bevelSize: Math.min(0.2, thickness * 0.06),
          bevelThickness,
          bevelSegments: 2,
          curveSegments: 1,
        })
        extrude.translate(-centerX, -centerY, 0)

        const surface = isAcrylic
          ? new THREE.MeshPhysicalMaterial({
              color: previewColor,
              roughness: previewRoughness,
              metalness: 0,
              transmission: 0.72,
              transparent: true,
              opacity: previewOpacity,
              thickness: thickness,
              ior: 1.49,
              side: THREE.DoubleSide,
            })
          : new THREE.MeshStandardMaterial({
              color: previewColor,
              roughness: previewRoughness,
              metalness: 0,
              transparent: previewOpacity < 1,
              opacity: previewOpacity,
            })
        const mesh = new THREE.Mesh(extrude, surface)
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.position.copy(pieceTransforms[index].position)
        mesh.userData.previewPieceId = piece.id
        sceneObjects.add(mesh)

        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(extrude, 28),
          new THREE.LineBasicMaterial({ color: isAcrylic ? '#28778d' : '#6a4328', transparent: true, opacity: 0.62 }),
        )
        edges.position.copy(mesh.position)
        sceneObjects.add(edges)

        let topSurfaceGeometry: THREE.ShapeGeometry | undefined
        const pieceBounds = bounds(piece.outer)
        rasterSurfaces.forEach((raster) => {
          if (!intersects(pieceBounds, raster.layerBounds)) return
          if (!topSurfaceGeometry) {
            topSurfaceGeometry = new THREE.ShapeGeometry(shape, 1)
            topSurfaceGeometry.translate(-centerX, -centerY, 0)
          }
          const imageSurface = new THREE.Mesh(topSurfaceGeometry, raster.material)
          imageSurface.position.set(
            mesh.position.x,
            mesh.position.y,
            mesh.position.z + topSurfaceZ + surfaceOverlayGap + raster.order * 0.002,
          )
          imageSurface.renderOrder = layerRenderOrder(raster.layer.z_index, raster.sequence)
          imageSurface.userData.previewRasterLayerId = raster.layer.id
          imageSurface.userData.previewPieceId = piece.id
          sceneObjects.add(imageSurface)
        })
      })

      const rasterLayerIds = new Set(rasterLayers.map(({ layer }) => layer.id))
      geometry.paths
        .filter((path) => {
          const operation = String(path.operation ?? '').toLowerCase()
          return /engrave|raster|score/.test(operation) && !(operation.includes('raster') && rasterLayerIds.has(path.id))
        })
        .forEach((path, index) => {
          if (path.points.length < 2) return
          const lineZ = topSurfaceZ + surfaceOverlayGap + rasterSurfaces.length * 0.002 + 0.004
          const points = path.points.map(([x, y]) => new THREE.Vector3(x - centerX, pageHeight - y - centerY, lineZ))
          if (path.closed) points.push(points[0].clone())
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: isAcrylic ? '#215d70' : '#744129', transparent: true, opacity: 0.78 }),
          )
          line.renderOrder = layerRenderOrder(path.z_index, index)
          const pathPoint = path.points.find((point) => transformForPoint(point)) ?? path.points[0]
          const pieceTransform = transformForPoint(pathPoint)
          if (pieceTransform) line.position.copy(pieceTransform)
          line.userData.previewPathId = path.id
          sceneObjects.add(line)
        })

      const selectedObjectIds = new Set(selectedCheck?.object_ids ?? [])
      geometry.paths
        .filter((path) => selectedObjectIds.has(path.id) && path.points.length >= 2)
        .forEach((path) => {
          const lineZ = topSurfaceZ + surfaceOverlayGap + rasterSurfaces.length * 0.002 + 0.025
          const points = path.points.map(([x, y]) => new THREE.Vector3(x - centerX, pageHeight - y - centerY, lineZ))
          if (path.closed) points.push(points[0].clone())
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({
              color: '#2d5bdb',
              transparent: true,
              opacity: 1,
              depthTest: false,
              depthWrite: false,
            }),
          )
          const pathPoint = path.points.find((point) => transformForPoint(point)) ?? path.points[0]
          const pieceTransform = transformForPoint(pathPoint)
          if (pieceTransform) line.position.copy(pieceTransform)
          line.renderOrder = 21_000
          line.userData.previewSelectedPathId = path.id
          sceneObjects.add(line)
        })

      const explicitFindingMarkers = (selectedCheck?.markers ?? []).filter((marker) => finitePoint(marker.location_mm))
      const findingMarkers = explicitFindingMarkers.length
        ? explicitFindingMarkers
        : geometry.paths
            .filter((path) => selectedObjectIds.has(path.id) && finitePoint(path.points[0]))
            .map((path) => ({
              id: `selected-${path.id}`,
              kind: 'object' as const,
              label: path.id,
              object_ids: [path.id],
              location_mm: path.points[0],
            }))
      if (findingMarkers.length) {
        const markerRadius = Math.max(0.8, Math.min(2.2, maxDimension * 0.007))
        findingMarkers.forEach((finding, index) => {
          const texture = numberedMarkerTexture(index + 1, '#2d5bdb')
          const marker = texture
            ? new THREE.Sprite(new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                depthTest: false,
                depthWrite: false,
                toneMapped: false,
              }))
            : new THREE.Mesh(
                new THREE.CircleGeometry(markerRadius, 28),
                new THREE.MeshBasicMaterial({ color: '#2d5bdb', depthTest: false, depthWrite: false }),
              )
          const pieceTransform = transformForPoint(finding.location_mm)
          marker.position.set(
            finding.location_mm[0] - centerX + (pieceTransform?.x ?? 0),
            pageHeight - finding.location_mm[1] - centerY + (pieceTransform?.y ?? 0),
            topSurfaceZ + 0.28 + (pieceTransform?.z ?? 0),
          )
          if (marker instanceof THREE.Sprite) marker.scale.setScalar(markerRadius * 3.4)
          marker.renderOrder = 22_000
          marker.userData.previewFindingMarkerId = finding.id
          marker.userData.previewFindingMarkerKind = finding.kind
          sceneObjects.add(marker)
        })
      }

      if (showWeakPoints) {
        const markerRadius = Math.max(0.8, Math.min(2.2, maxDimension * 0.007))
        weakPoints.forEach((point, pointIndex) => {
          const color = weakPointColor(point.kind)
          const markerTexture = numberedMarkerTexture(pointIndex + 1, color)
          const marker = markerTexture
            ? new THREE.Sprite(new THREE.SpriteMaterial({
                map: markerTexture,
                transparent: true,
                depthTest: false,
                depthWrite: false,
                toneMapped: false,
              }))
            : new THREE.Mesh(
                new THREE.CircleGeometry(markerRadius, 28),
                new THREE.MeshBasicMaterial({
                  color,
                  transparent: true,
                  opacity: 0.95,
                  depthTest: false,
                  depthWrite: false,
                  side: THREE.DoubleSide,
                }),
              )
          marker.position.set(
            point.location_mm[0] - centerX,
            pageHeight - point.location_mm[1] - centerY,
            topSurfaceZ + 0.24,
          )
          if (marker instanceof THREE.Sprite) marker.scale.setScalar(markerRadius * 3.4)
          marker.renderOrder = 20_000
          marker.userData.previewWeakPointId = point.id
          marker.userData.previewWeakPointKind = point.kind
          marker.userData.previewWeakPointIndex = pointIndex + 1
          sceneObjects.add(marker)

          if (point.span_mm) {
            const span = point.span_mm.map(([x, y]) => (
              new THREE.Vector3(x - centerX, pageHeight - y - centerY, topSurfaceZ + 0.22)
            ))
            const spanLine = new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(span),
              new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity: 0.98,
                depthTest: false,
                depthWrite: false,
              }),
            )
            spanLine.renderOrder = 19_999
            spanLine.userData.previewWeakPointId = point.id
            sceneObjects.add(spanLine)
            span.forEach((endpoint, index) => {
              const endpointMarker = new THREE.Mesh(
                new THREE.SphereGeometry(markerRadius * 0.48, 14, 10),
                new THREE.MeshBasicMaterial({
                  color,
                  transparent: true,
                  opacity: 0.9,
                  depthTest: false,
                  depthWrite: false,
                }),
              )
              endpointMarker.position.copy(endpoint)
              endpointMarker.renderOrder = 20_001
              endpointMarker.userData.previewWeakPointId = point.id
              endpointMarker.userData.previewWeakPointEndpoint = index
              sceneObjects.add(endpointMarker)
            })
          }
        })
      }

      scene.add(sceneObjects)
      const platform = new THREE.Mesh(
        new THREE.CircleGeometry(maxDimension * 1.08, 72),
        new THREE.MeshStandardMaterial({ color: '#dfe3e8', roughness: 1 }),
      )
      platform.position.z = -Math.max(thickness * 0.3, 1.1)
      platform.receiveShadow = true
      sceneObjects.add(platform)

      resizeObserver = new ResizeObserver(() => {
        const nextWidth = Math.max(host.clientWidth, 300)
        const nextHeight = Math.max(host.clientHeight, 360)
        camera.aspect = nextWidth / nextHeight
        camera.updateProjectionMatrix()
        renderer?.setSize(nextWidth, nextHeight)
      })
      resizeObserver.observe(host)

      const render = () => {
        animationFrame = requestAnimationFrame(render)
        controls?.update()
        renderer?.render(scene, camera)
      }
      render()

      return () => {
        resourcesActive = false
        viewStateRef.current = {
          geometry,
          camera: [camera.position.x, camera.position.y, camera.position.z],
          target: [controls?.target.x ?? 0, controls?.target.y ?? 0, controls?.target.z ?? 0],
        }
        cancelAnimationFrame(animationFrame)
        resizeObserver?.disconnect()
        controls?.dispose()
        disposeObject(sceneObjects, rasterMaterials, rasterTextures)
        renderer?.dispose()
        renderer?.domElement.remove()
      }
    } catch {
      resourcesActive = false
      setRenderError('This browser could not start the 3D preview. The 2D preflight results are still available.')
      resizeObserver?.disconnect()
      cancelAnimationFrame(animationFrame)
      controls?.dispose()
      disposeObject(sceneObjects, rasterMaterials, rasterTextures)
      renderer?.dispose()
      renderer?.domElement.remove()
    }
  }, [effectiveExploded, geometry, isAcrylic, kerfMm, previewColor, previewOpacity, previewRoughness, selectedCheck, showSheetReference, showWeakPoints, thicknessMm, weakPoints])

  if (!geometry.valid_3d) {
    return (
      <div className="preview-unavailable" role="status">
        <strong>3D preview unavailable</strong>
        <p>{geometry.invalid_reason || 'Closed, non-overlapping cut regions are needed before pieces can be extruded.'}</p>
      </div>
    )
  }

  return (
    <div className="preview-3d-wrap">
      <div className="preview-controls" aria-label="3D preview options">
        <label className={`switch-control${showWeakPoints ? ' is-disabled' : ''}`} title={showWeakPoints ? 'Turn off Weak points to explode pieces.' : undefined}>
          <input type="checkbox" checked={effectiveExploded} disabled={showWeakPoints} onChange={(event) => setExploded(event.target.checked)} />
          <span aria-hidden="true" />
          Explode pieces
        </label>
        <label className="switch-control">
          <input type="checkbox" checked={showSheetReference} onChange={(event) => setShowSheetReference(event.target.checked)} />
          <span aria-hidden="true" />
          Show sheet reference
        </label>
      </div>
      {renderError ? <div className="preview-unavailable" role="status"><p>{renderError}</p></div> : null}
      <div
        className="three-host"
        ref={hostRef}
        hidden={Boolean(renderError)}
        aria-hidden={renderError ? 'true' : undefined}
        role="img"
        aria-label={`Approximate three-dimensional ${isAcrylic ? 'acrylic' : 'wood'} cut preview${rasterLayerCount ? ` with ${rasterLayerCount} embedded image ${rasterLayerCount === 1 ? 'layer' : 'layers'} on material surfaces` : ''}${showWeakPoints && weakPoints.length ? ` and ${weakPoints.length} potential weak ${weakPoints.length === 1 ? 'point' : 'points'} highlighted` : ''}. Drag to orbit and scroll to zoom.`}
      />
      <p className="preview-hint">
        Drag to orbit · Scroll to zoom · Approximate {formatInches(kerfMm)} kerf
        {showSheetReference ? ' · Translucent sheet is a size reference, not predicted scrap' : ''}
      </p>
      {rasterLayerCount ? (
        <p className="preview-hint">
          {rasterLayerCount === 1 ? 'Embedded image is' : 'Embedded images are'} shown as multiply layers on material surfaces and the optional sheet reference.
        </p>
      ) : null}
      {showWeakPoints ? (
        <p className="preview-hint weak-point-hint">
          Potential weak points are material-guideline estimates. Exploded view is disabled so their measured locations remain aligned.
        </p>
      ) : null}
    </div>
  )
}
