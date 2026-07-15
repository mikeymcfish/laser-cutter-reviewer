import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewGeometry } from '../types'

const threeState = vi.hoisted(() => ({
  loadedSources: [] as string[],
  textures: [] as Array<{ dispose: () => void }>,
  scene: null as unknown,
  camera: null as unknown,
  controls: null as unknown,
  failRenderer: false,
}))

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()

  class WebGLRendererMock {
    domElement = document.createElement('canvas')
    shadowMap = { enabled: false, type: actual.PCFSoftShadowMap }
    outputColorSpace = actual.SRGBColorSpace
    constructor() {
      if (threeState.failRenderer) throw new Error('WebGL unavailable')
    }
    setPixelRatio() {}
    setSize() {}
    render(scene: THREE.Scene, camera: THREE.Camera) {
      threeState.scene = scene
      threeState.camera = camera
    }
    dispose() {}
  }

  class TextureLoaderMock {
    load(source: string) {
      threeState.loadedSources.push(source)
      const texture = new actual.Texture()
      texture.dispose = vi.fn(texture.dispose.bind(texture))
      threeState.textures.push(texture)
      return texture
    }
  }

  return { ...actual, WebGLRenderer: WebGLRendererMock, TextureLoader: TextureLoaderMock }
})

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class OrbitControlsMock {
    enableDamping = false
    dampingFactor = 0
    target = {
      x: 0,
      y: 0,
      z: 0,
      set(x = 0, y = 0, z = 0) {
        this.x = x
        this.y = y
        this.z = z
      },
    }
    minDistance = 0
    maxDistance = 0
    constructor() { threeState.controls = this }
    update() {}
    dispose() {}
  },
}))

import { Preview3D, rasterPlacement, renderableRasterLayers, renderableWeakPoints } from './Preview3D'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const geometry: PreviewGeometry = {
  page: { width_mm: 100, height_mm: 50 },
  paths: [
    { id: 'photo', z_index: 2, operation: 'raster-engrave', closed: true, points: [[10, 5], [30, 5], [30, 15], [10, 15]] },
  ],
  pieces: [{ id: 'piece', outer: [[0, 0], [45, 0], [45, 30], [0, 30]], holes: [] }],
  raster_assets: [
    { id: 'safe', data_url: png, pixel_width: 20, pixel_height: 10, preview_width_px: 20, preview_height_px: 10 },
    { id: 'remote', data_url: 'https://example.test/image.png', pixel_width: 1, pixel_height: 1, preview_width_px: 1, preview_height_px: 1 },
  ],
  raster_layers: [
    { id: 'photo', asset_id: 'safe', corners_mm: [[10, 5], [30, 5], [30, 15], [10, 15]], opacity: 0.65, blend_mode: 'multiply', z_index: 2, preserve_aspect_ratio: 'none', viewport_aspect_ratio: 2 },
    { id: 'linked', asset_id: 'remote', corners_mm: [[35, 5], [40, 5], [40, 10], [35, 10]], opacity: 1, blend_mode: 'multiply', z_index: 1, preserve_aspect_ratio: 'none', viewport_aspect_ratio: 1 },
  ],
  valid_3d: true,
}

describe('Preview3D embedded rasters', () => {
  beforeEach(() => {
    threeState.loadedSources = []
    threeState.textures = []
    threeState.scene = null
    threeState.camera = null
    threeState.controls = null
    threeState.failRenderer = false
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
    } as unknown as CanvasRenderingContext2D)
  })

  it('projects only sanitized PNG layers onto cut-piece top surfaces and disposes their resources', () => {
    const { unmount } = render(
      <Preview3D geometry={geometry} materialType="wood" thicknessMm={3} kerfMm={0.1} />,
    )

    expect(screen.getByRole('img', { name: /with 1 embedded image layer on material surfaces/ })).toBeInTheDocument()
    expect(threeState.loadedSources).toEqual([png])

    const imageSurfaces: THREE.Mesh[] = []
    ;(threeState.scene as THREE.Scene).traverse((object) => {
      if (object instanceof THREE.Mesh && object.userData.previewRasterLayerId) imageSurfaces.push(object)
    })
    expect(imageSurfaces).toHaveLength(2)
    const referenceSurface = imageSurfaces.find((surface) => surface.userData.previewRasterSurface === 'sheet-reference')!
    const pieceSurface = imageSurfaces.find((surface) => surface.userData.previewPieceId === 'piece')!
    expect(referenceSurface.userData).toMatchObject({ previewRasterLayerId: 'photo', previewRasterSurface: 'sheet-reference' })
    expect(pieceSurface.userData).toMatchObject({ previewRasterLayerId: 'photo', previewPieceId: 'piece' })
    const material = pieceSurface.material as THREE.ShaderMaterial
    expect(material.blending).toBe(THREE.MultiplyBlending)
    expect(material.depthWrite).toBe(false)
    expect(material.uniforms.layerOpacity.value).toBe(0.65)
    expect(material.uniforms.rasterOrigin.value.toArray()).toEqual([-40, 20])
    expect(material.uniforms.rasterAxisX.value.toArray()).toEqual([20, 0])
    expect(material.uniforms.rasterAxisY.value.toArray()).toEqual([0, -10])
    expect(pieceSurface.position.z).toBeGreaterThan(3 + Math.min(0.16, 3 * 0.05))

    const texture = threeState.textures[0]
    const materialDispose = vi.spyOn(material, 'dispose')
    const geometryDispose = vi.spyOn(pieceSurface.geometry, 'dispose')
    unmount()
    expect(texture.dispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
    expect(geometryDispose).toHaveBeenCalledTimes(1)
  })

  it('keeps an embedded image visible on the sheet when it falls outside every inferred piece', () => {
    const outsideGeometry: PreviewGeometry = {
      ...geometry,
      paths: [{ ...geometry.paths[0], points: [[60, 5], [80, 5], [80, 15], [60, 15]] }],
      raster_layers: [{
        ...geometry.raster_layers![0],
        corners_mm: [[60, 5], [80, 5], [80, 15], [60, 15]],
      }],
    }
    render(<Preview3D geometry={outsideGeometry} materialType="wood" thicknessMm={3} kerfMm={0.1} />)

    const surfaces: THREE.Mesh[] = []
    ;(threeState.scene as THREE.Scene).traverse((object) => {
      if (object instanceof THREE.Mesh && object.userData.previewRasterLayerId) surfaces.push(object)
    })
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0].userData.previewRasterSurface).toBe('sheet-reference')
  })

  it('uses the camera-size floor for fog on small valid pages', () => {
    const tinyGeometry: PreviewGeometry = {
      page: { width_mm: 6.35, height_mm: 6.35 },
      paths: [],
      pieces: [],
      valid_3d: true,
    }
    render(<Preview3D geometry={tinyGeometry} materialType="wood" thicknessMm={3} kerfMm={0.1} />)
    const fog = (threeState.scene as THREE.Scene).fog as THREE.Fog
    expect(fog.near).toBe(75)
    expect(fog.far).toBe(200)
  })

  it('shows one fallback surface after WebGL failure and clears it on a successful retry', async () => {
    threeState.failRenderer = true
    const { container, rerender } = render(
      <Preview3D geometry={geometry} materialType="wood" thicknessMm={3} kerfMm={0.1} />,
    )

    expect(screen.getAllByText(/could not start the 3D preview/)).toHaveLength(1)
    expect(container.querySelector('.three-host')).toHaveAttribute('hidden')

    threeState.failRenderer = false
    rerender(<Preview3D geometry={geometry} materialType="wood" thicknessMm={4} kerfMm={0.1} />)
    await waitFor(() => expect(screen.queryByText(/could not start the 3D preview/)).not.toBeInTheDocument())
    expect(container.querySelector('.three-host')).not.toHaveAttribute('hidden')
  })

  it('moves engraving with its owning piece and preserves the camera across display toggles', () => {
    const engravedGeometry: PreviewGeometry = {
      page: { width_mm: 100, height_mm: 50 },
      paths: [{ id: 'engraving', z_index: 0, operation: 'engrave', points: [[65, 10], [80, 10]], closed: false }],
      pieces: [{ id: 'right-piece', outer: [[60, 5], [90, 5], [90, 30], [60, 30]], holes: [] }],
      valid_3d: true,
    }
    render(<Preview3D geometry={engravedGeometry} materialType="wood" thicknessMm={3} kerfMm={0.1} />)
    const camera = threeState.camera as THREE.PerspectiveCamera
    camera.position.set(17, -23, 41)
    const controls = threeState.controls as { target: { set: (x: number, y: number, z: number) => void } }
    controls.target.set(2, 3, 4)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Explode pieces' }))

    let engraving: THREE.Object3D | undefined
    let piece: THREE.Object3D | undefined
    ;(threeState.scene as THREE.Scene).traverse((object) => {
      if (object.userData.previewPathId === 'engraving') engraving = object
      if (object.userData.previewPieceId === 'right-piece') piece = object
    })
    expect(engraving?.position.toArray()).toEqual(piece?.position.toArray())
    expect(engraving?.position.length()).toBeGreaterThan(0)
    expect((threeState.camera as THREE.PerspectiveCamera).position.toArray()).toEqual([17, -23, 41])
    expect((threeState.controls as { target: { x: number; y: number; z: number } }).target).toMatchObject({ x: 2, y: 3, z: 4 })
  })

  it('circles localized endpoints and intersections for the selected finding', () => {
    render(
      <Preview3D
        geometry={geometry}
        materialType="wood"
        thicknessMm={3}
        kerfMm={0.1}
        selectedCheck={{
          rule_id: 'geometry.open_paths',
          title: 'Open cut paths',
          state: 'blocker',
          object_ids: ['photo'],
          markers: [{
            id: 'open-photo-start',
            kind: 'open_endpoint',
            label: 'Open endpoint',
            object_ids: ['photo'],
            location_mm: [10, 5],
          }],
        }}
      />,
    )

    let marker: THREE.Object3D | undefined
    let highlightedPath: THREE.Object3D | undefined
    ;(threeState.scene as THREE.Scene).traverse((object) => {
      if (object.userData.previewFindingMarkerId === 'open-photo-start') marker = object
      if (object.userData.previewSelectedPathId === 'photo') highlightedPath = object
    })
    expect(marker).toBeInstanceOf(THREE.Sprite)
    expect(marker?.userData.previewFindingMarkerKind).toBe('open_endpoint')
    expect(highlightedPath).toBeInstanceOf(THREE.Line)
  })

  it('filters invalid layers and applies SVG placement in the local viewport before affine transforms', () => {
    expect(renderableRasterLayers(geometry).map(({ layer }) => layer.id)).toEqual(['photo'])
    const squareAsset = { ...geometry.raster_assets![0], preview_width_px: 10, preview_height_px: 10 }

    expect(rasterPlacement(geometry.raster_assets![0], 'xMaxYMin meet', 2)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
    expect(rasterPlacement(squareAsset, 'xMaxYMin meet', 2)).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 1,
    })
    expect(rasterPlacement(squareAsset, 'xMidYMax slice', 2)).toEqual({
      x: 0,
      y: -1,
      width: 1,
      height: 2,
    })
  })

  it('renders measured weak-point spans above the material and disables exploded mode', () => {
    const weakGeometry: PreviewGeometry = {
      ...geometry,
      weak_points: {
        status: 'complete',
        message: 'One potential weak point.',
        points: [{
          id: 'weak-point-0001',
          kind: 'narrow_feature',
          label: 'Narrow feature',
          object_ids: ['piece'],
          location_mm: [20, 10],
          span_mm: [[20, 9], [20, 11]],
          measurement: 2,
          threshold: 3,
          unit: 'mm',
        }],
      },
    }
    const { unmount } = render(
      <Preview3D geometry={weakGeometry} materialType="wood" thicknessMm={3} kerfMm={0.1} showWeakPoints />,
    )

    expect(screen.getByRole('img', { name: /1 potential weak point highlighted/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Explode pieces' })).toBeDisabled()
    expect(screen.getByText(/Exploded view is disabled/)).toBeInTheDocument()
    expect(renderableWeakPoints(weakGeometry)).toHaveLength(1)

    const markers: THREE.Object3D[] = []
    ;(threeState.scene as THREE.Scene).traverse((object) => {
      if (object.userData.previewWeakPointId === 'weak-point-0001') markers.push(object)
    })
    expect(markers).toHaveLength(4)
    const center = markers.find((object) => object.userData.previewWeakPointKind === 'narrow_feature')!
    expect(center).toBeInstanceOf(THREE.Sprite)
    expect(center.userData.previewWeakPointIndex).toBe(1)
    expect(center.position.x).toBe(-30)
    expect(center.position.y).toBe(15)
    expect(center.position.z).toBeCloseTo(3.39)
    expect(center.renderOrder).toBeGreaterThan(1_000)
    const markerTexture = (center as THREE.Sprite).material.map!
    expect(markerTexture).toBeInstanceOf(THREE.CanvasTexture)
    expect(markerTexture.name).toBe('Weak point 1')
    const textureDispose = vi.spyOn(markerTexture, 'dispose')
    const materialDispose = vi.spyOn((center as THREE.Sprite).material, 'dispose')
    unmount()
    expect(textureDispose).toHaveBeenCalledTimes(1)
    expect(materialDispose).toHaveBeenCalledTimes(1)
  })
})
