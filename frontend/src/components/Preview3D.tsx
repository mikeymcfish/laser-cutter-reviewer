import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Point, PreviewGeometry } from '../types'
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

const addLoop = (target: THREE.Shape | THREE.Path, points: Point[], pageHeight: number) => {
  const first = points[0]
  if (!first) return
  target.moveTo(first[0], pageHeight - first[1])
  points.slice(1).forEach(([x, y]) => target.lineTo(x, pageHeight - y))
  target.closePath()
}

const disposeObject = (object: THREE.Object3D) => {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry?.dispose()
      const material = child.material as THREE.Material | THREE.Material[]
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material?.dispose()
    }
  })
}

export function Preview3D({ geometry, materialType, thicknessMm, kerfMm, previewAppearance }: Preview3DProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [exploded, setExploded] = useState(false)
  const [showSheetReference, setShowSheetReference] = useState(true)
  const [renderError, setRenderError] = useState('')
  const isAcrylic = materialType.toLowerCase().includes('acrylic')
  const previewColor = previewAppearance?.color ?? (isAcrylic ? '#72c4dc' : '#c89a62')
  const previewOpacity = Math.min(1, Math.max(0, previewAppearance?.opacity ?? (isAcrylic ? 0.78 : 1)))
  const previewRoughness = Math.min(1, Math.max(0, previewAppearance?.roughness ?? (isAcrylic ? 0.12 : 0.72)))

  useEffect(() => {
    const host = hostRef.current
    if (!host || !geometry.valid_3d) return
    let animationFrame = 0
    let renderer: THREE.WebGLRenderer | undefined
    let resizeObserver: ResizeObserver | undefined
    const sceneObjects = new THREE.Group()

    try {
      const pageWidth = Number(geometry.page.width_mm) || 1
      const pageHeight = Number(geometry.page.height_mm) || 1
      const width = Math.max(host.clientWidth, 300)
      const height = Math.max(host.clientHeight, 360)
      const scene = new THREE.Scene()
      scene.background = new THREE.Color('#edf0f4')
      scene.fog = new THREE.Fog('#edf0f4', Math.max(pageWidth, pageHeight) * 1.5, Math.max(pageWidth, pageHeight) * 4)

      const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 5000)
      const maxDimension = Math.max(pageWidth, pageHeight, 50)
      camera.position.set(maxDimension * 0.72, -maxDimension * 0.92, maxDimension * 0.95)

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(width, height)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      host.replaceChildren(renderer.domElement)

      const controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.06
      controls.target.set(0, 0, 0)
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
      const centerX = pageWidth / 2
      const centerY = pageHeight / 2

      if (showSheetReference) {
        const offcutGeometry = new THREE.BoxGeometry(pageWidth, pageHeight, Math.max(thickness * 0.12, 0.35))
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
          bevelThickness: Math.min(0.16, thickness * 0.05),
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
        if (exploded) {
          const pieceBounds = bounds(piece.outer)
          const pieceX = (pieceBounds.minX + pieceBounds.maxX) / 2 - centerX
          const pieceY = centerY - (pieceBounds.minY + pieceBounds.maxY) / 2
          const length = Math.hypot(pieceX, pieceY) || 1
          const spread = maxDimension * (0.045 + (index % 3) * 0.009)
          mesh.position.set((pieceX / length) * spread, (pieceY / length) * spread, index * thickness * 0.12)
        }
        sceneObjects.add(mesh)

        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(extrude, 28),
          new THREE.LineBasicMaterial({ color: isAcrylic ? '#28778d' : '#6a4328', transparent: true, opacity: 0.62 }),
        )
        edges.position.copy(mesh.position)
        sceneObjects.add(edges)
      })

      geometry.paths
        .filter((path) => String(path.operation ?? '').toLowerCase().match(/engrave|raster|score/))
        .forEach((path) => {
          if (path.points.length < 2) return
          const points = path.points.map(([x, y]) => new THREE.Vector3(x - centerX, pageHeight - y - centerY, thickness + 0.08))
          if (path.closed) points.push(points[0].clone())
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: isAcrylic ? '#215d70' : '#744129', transparent: true, opacity: 0.78 }),
          )
          sceneObjects.add(line)
        })

      scene.add(sceneObjects)
      const platform = new THREE.Mesh(
        new THREE.CircleGeometry(maxDimension * 1.08, 72),
        new THREE.MeshStandardMaterial({ color: '#dfe3e8', roughness: 1 }),
      )
      platform.position.z = -Math.max(thickness * 0.3, 1.1)
      platform.receiveShadow = true
      scene.add(platform)

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
        controls.update()
        renderer?.render(scene, camera)
      }
      render()

      return () => {
        cancelAnimationFrame(animationFrame)
        resizeObserver?.disconnect()
        controls.dispose()
        disposeObject(sceneObjects)
        renderer?.dispose()
        renderer?.domElement.remove()
      }
    } catch {
      setRenderError('This browser could not start the 3D preview. The 2D preflight results are still available.')
      renderer?.dispose()
      resizeObserver?.disconnect()
      cancelAnimationFrame(animationFrame)
      disposeObject(sceneObjects)
    }
  }, [exploded, geometry, isAcrylic, kerfMm, previewColor, previewOpacity, previewRoughness, showSheetReference, thicknessMm])

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
        <label className="switch-control">
          <input type="checkbox" checked={exploded} onChange={(event) => setExploded(event.target.checked)} />
          <span aria-hidden="true" />
          Explode pieces
        </label>
        <label className="switch-control">
          <input type="checkbox" checked={showSheetReference} onChange={(event) => setShowSheetReference(event.target.checked)} />
          <span aria-hidden="true" />
          Show sheet reference
        </label>
      </div>
      {renderError ? <div className="preview-unavailable"><p>{renderError}</p></div> : null}
      <div
        className="three-host"
        ref={hostRef}
        role="img"
        aria-label={`Approximate three-dimensional ${isAcrylic ? 'acrylic' : 'wood'} cut preview. Drag to orbit and scroll to zoom.`}
      />
      <p className="preview-hint">
        Drag to orbit · Scroll to zoom · Approximate {formatInches(kerfMm)} kerf
        {showSheetReference ? ' · Translucent sheet is a size reference, not predicted scrap' : ''}
      </p>
    </div>
  )
}
