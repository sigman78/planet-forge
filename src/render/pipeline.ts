import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import atmoFrag from '../shaders/atmosphere_pass.frag.glsl?raw';
import atmoCommon from '../shaders/atmosphere_common.glsl?raw';
import type { SharedUniforms } from './planetView.ts';

/** Renders the scene into an HDR target with a depth texture, then applies the atmosphere. */
class SceneAtmospherePass extends Pass {
  readonly sceneRT: THREE.WebGLRenderTarget;
  readonly material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private frame = 0;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    shared: SharedUniforms,
    w: number,
    h: number,
    samples: number,
  ) {
    super();
    const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      depthTexture,
      samples,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        tColor: { value: null },
        tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunIntensity: { value: 1.0 },
        uSteps: { value: 16 },
        uFrame: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: atmoCommon + atmoFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(w: number, h: number) {
    this.sceneRT.setSize(w, h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    const U = this.material.uniforms;
    U.tColor.value = this.sceneRT.texture;
    U.tDepth.value = this.sceneRT.depthTexture;
    U.uInvProj.value.copy(this.camera.projectionMatrixInverse);
    U.uCamWorld.value.copy(this.camera.matrixWorld);
    U.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    U.uFrame.value = this.frame++ % 64;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.sceneRT.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

export class Pipeline {
  readonly composer: EffectComposer;
  readonly atmo: SceneAtmospherePass;
  readonly bloom: UnrealBloomPass;
  readonly smaa: SMAAPass;
  readonly output: OutputPass;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    shared: SharedUniforms,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.atmo = new SceneAtmospherePass(scene, camera, shared, size.x, size.y, 4);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.6, 1.2);
    this.output = new OutputPass();
    this.smaa = new SMAAPass();
    this.composer.addPass(this.atmo);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.smaa);
  }

  get atmoUniforms() {
    return this.atmo.material.uniforms;
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.atmo.setSize(size.x, size.y);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
