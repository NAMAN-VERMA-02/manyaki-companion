import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm'

// The overlay covers the whole display. The model stays at real-world scale (metres) so spring-bone
// physics behave; the orthographic camera maps screen pixels (DIPs) to metres instead:
// world = px / ppm, y up, origin at the bottom-left of the window.
export class Avatar {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.OrthographicCamera
  /** Feet anchor in world metres. Rotation y = facing. */
  readonly root = new THREE.Group()
  vrm!: VRM
  heightPx = 260
  private modelHeight = 1.5
  private width = 1
  private height = 1
  private readonly pixel = new Uint8Array(4)

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -50, 50)
    this.camera.position.set(0, 0, 10)
    this.scene.add(this.root)

    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(0.4, 1, 1.2)
    const fill = new THREE.AmbientLight(0xffffff, 1.1)
    this.scene.add(key, fill)
  }

  async load(url: string, onProgress?: (p: number) => void): Promise<void> {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total))
    const vrm = gltf.userData.vrm as VRM
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.rotateVRM0(vrm)
    vrm.scene.traverse((o) => { o.frustumCulled = false })
    this.vrm = vrm
    this.root.add(vrm.scene)

    // Measure standing height from the rest pose.
    vrm.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(vrm.scene)
    this.modelHeight = Math.max(0.5, box.max.y - Math.min(0, box.min.y))
    this.setHeight(this.heightPx)
  }

  setHeight(px: number) {
    // Keep her feet where they are on screen while the scale changes.
    const feet = this.modelHeight ? this.toScreen(this.root.position) : null
    this.heightPx = px
    this.updateCamera()
    if (feet) this.setFeet(feet.x, feet.y)
  }

  /** Pixels per metre. */
  get scale() { return this.heightPx / this.modelHeight }
  get modelMetres() { return this.modelHeight }

  /** The window may be a small rect that follows her: (x, y) is its top-left in display coordinates. */
  readonly view = { x: 0, y: 0 }

  /** displayHeight: logical height of the display (world y = displayHeight - screen y). */
  setDisplayHeight(h: number) {
    this.height = h
    this.updateCamera()
  }

  /** Set the window's rect in display coordinates; resizes the canvas only when the size changes. */
  setView(x: number, y: number, w: number, h: number) {
    this.view.x = x
    this.view.y = y
    if (w !== this.width || h !== this.viewH) {
      this.width = w
      this.viewH = h
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      this.renderer.setSize(w, h, false)
    }
    this.updateCamera()
  }

  private viewH = 1

  private updateCamera() {
    const ppm = this.scale
    this.camera.left = this.view.x / ppm
    this.camera.right = (this.view.x + this.width) / ppm
    this.camera.top = (this.height - this.view.y) / ppm
    this.camera.bottom = (this.height - this.view.y - this.viewH) / ppm
    this.camera.updateProjectionMatrix()
  }

  /** Display point (DIPs, top-left origin) -> world metres. */
  toWorld(sx: number, sy: number, z = 0, out = new THREE.Vector3()) {
    const ppm = this.scale
    return out.set(sx / ppm, (this.height - sy) / ppm, z)
  }

  /** Place her feet at a screen position. */
  setFeet(screenX: number, screenY: number) {
    this.toWorld(screenX, screenY, 0, this.root.position)
  }

  bone(name: VRMHumanBoneName) {
    return this.vrm.humanoid.getNormalizedBoneNode(name)
  }

  rawBone(name: VRMHumanBoneName) {
    return this.vrm.humanoid.getRawBoneNode(name)
  }

  /** Screen position (top-left origin) of a world point. */
  toScreen(world: THREE.Vector3): { x: number; y: number } {
    const ppm = this.scale
    return { x: world.x * ppm, y: this.height - world.y * ppm }
  }

  boneScreen(name: VRMHumanBoneName, offset?: THREE.Vector3): { x: number; y: number } {
    const node = this.rawBone(name)
    const v = new THREE.Vector3()
    if (node) {
      if (offset) node.localToWorld(v.copy(offset))
      else node.getWorldPosition(v)
    } else this.root.getWorldPosition(v)
    return this.toScreen(v)
  }

  render() {
    this.renderer.render(this.scene, this.camera)
  }

  /** True if the pixel under the cursor (display DIPs) is part of her. Call right after render(). */
  hitTest(x: number, y: number): boolean {
    const gl = this.renderer.getContext()
    const pr = this.renderer.getPixelRatio()
    const px = Math.floor((x - this.view.x) * pr)
    const py = Math.floor((this.view.y + this.viewH - y) * pr)
    if (px < 0 || py < 0 || px >= gl.drawingBufferWidth || py >= gl.drawingBufferHeight) return false
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel)
    return this.pixel[3] > 24
  }

  /** Approximate on-screen bounding box of her body (for the bubble, the cursor-avoid logic, etc). */
  screenBox(): { left: number; right: number; top: number; bottom: number } {
    const feet = this.toScreen(this.root.position)
    const halfW = this.heightPx * 0.28
    return { left: feet.x - halfW, right: feet.x + halfW, top: feet.y - this.heightPx, bottom: feet.y }
  }
}
