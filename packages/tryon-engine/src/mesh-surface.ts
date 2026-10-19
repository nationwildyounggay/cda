import * as THREE from 'three'

interface Node {
  box: THREE.Box3
  triangles?: number[]
  left?: Node
  right?: Node
}

/** Small refittable BVH. Topology is fixed; sliders only update bounds. */
export class MeshSurface {
  private readonly root: Node
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly c = new THREE.Vector3()
  private readonly hit = new THREE.Vector3()
  private readonly ray = new THREE.Ray()
  private readonly inverse = new THREE.Matrix4()
  private readonly worldOrigin = new THREE.Vector3()
  private readonly direction = new THREE.Vector3()

  constructor(private readonly mesh: THREE.Mesh) {
    const geo = mesh.geometry
    const index = geo.getIndex()!
    const pos = geo.getAttribute('position')
    const centers = Array.from({ length: index.count / 3 }, (_, t) => {
      const center = new THREE.Vector3()
      for (let j = 0; j < 3; j++) center.add(new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + j)))
      return center.multiplyScalar(1 / 3)
    })
    const build = (triangles: number[]): Node => {
      const box = new THREE.Box3()
      if (triangles.length <= 16) return { box, triangles }
      const size = new THREE.Box3().setFromPoints(triangles.map(t => centers[t]!)).getSize(new THREE.Vector3())
      const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
      triangles.sort((a, b) => centers[a]![axis] - centers[b]![axis])
      const half = triangles.length >> 1
      return { box, left: build(triangles.slice(0, half)), right: build(triangles.slice(half)) }
    }
    this.root = build(centers.map((_, i) => i))
    this.refit()
  }

  private triangle(t: number): void {
    const index = this.mesh.geometry.getIndex()!
    const pos = this.mesh.geometry.getAttribute('position')
    this.a.fromBufferAttribute(pos, index.getX(t * 3))
    this.b.fromBufferAttribute(pos, index.getX(t * 3 + 1))
    this.c.fromBufferAttribute(pos, index.getX(t * 3 + 2))
  }

  refit(): void {
    const visit = (node: Node) => {
      node.box.makeEmpty()
      if (node.triangles) {
        for (const t of node.triangles) {
          this.triangle(t)
          node.box.expandByPoint(this.a).expandByPoint(this.b).expandByPoint(this.c)
        }
      } else {
        visit(node.left!)
        visit(node.right!)
        node.box.union(node.left!.box).union(node.right!.box)
      }
    }
    visit(this.root)
  }

  radiusAt(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number | null {
    this.direction.set(dx, dy, dz)
    if (this.direction.lengthSq() < 1e-18 || maxDist <= 0) return null
    this.worldOrigin.set(ox, oy, oz)
    this.mesh.updateWorldMatrix(true, false)
    this.inverse.copy(this.mesh.matrixWorld).invert()
    this.ray.set(this.worldOrigin, this.direction.normalize()).applyMatrix4(this.inverse)
    let nearest = Infinity
    const visit = (node: Node) => {
      if (!this.ray.intersectsBox(node.box)) return
      if (node.triangles) {
        for (const t of node.triangles) {
          this.triangle(t)
          // Rays start inside the body, so both face orientations must be accepted.
          if (!this.ray.intersectTriangle(this.a, this.b, this.c, false, this.hit)) continue
          const distance = this.hit.applyMatrix4(this.mesh.matrixWorld).distanceTo(this.worldOrigin)
          if (distance <= maxDist && distance < nearest) nearest = distance
        }
      } else {
        visit(node.left!)
        visit(node.right!)
      }
    }
    visit(this.root)
    return Number.isFinite(nearest) ? nearest : null
  }
}
