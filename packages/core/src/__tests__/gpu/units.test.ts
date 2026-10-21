import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {shaderRendererGPU} from '@coreroot/gpu/index'
import {createGpuUniformsMap} from '@coreroot/gpu/uniformBridge'
import type {GpuShaderDefinition, GpuUniformsMap} from '@coreroot/gpu/contract'
import type {NodeMetadata} from '@coreroot/types'
import {
    buildExtraSizeProps,
    resolveDimensionalProp,
    resolveDimensionalProps,
} from '@coreroot/utilities/dimensionalProps'
import {
    invalidateUnitEnvironment,
    lengthToPx,
    parseLength,
    setUnitEnvironmentOverride,
    toDimensional,
    usesViewportUnits,
} from '@coreroot/utilities/units'
import {halfUvFromProp} from '@coreroot/utilities/halfUvProps'
import {resolveLayoutConfig} from '@coreroot/utilities/layout'
import {measureNode} from '@coreroot/utilities/measure'
import RoundedRect from '@coreroot/shaders/RoundedRect/index'
import Circle from '@coreroot/shaders/Circle/index'
import Star from '@coreroot/shaders/Star/index'
import Trapezoid from '@coreroot/shaders/Trapezoid/index'
import Text from '@coreroot/shaders/Text/index'
import Repeater from '@coreroot/shaders/Repeater/index'
import Checkerboard from '@coreroot/shaders/Checkerboard/index'

/**
 * CSS-style length units on dimensional props (utilities/units.ts + dimensionalProps.ts).
 *
 * Canvas 800×400 throughout; the viewport is pinned to 1440×900 and the root font size to 16px
 * (setUnitEnvironmentOverride) so vw/vh/rem are deterministic. Expected values are worked out
 * by hand from the CSS definition of each unit, then through the prop's existing px → UV rule.
 */

const W = 800
const H = 400
const VW = 1440
const VH = 900

const rr = RoundedRect as GpuShaderDefinition
const circle = Circle as GpuShaderDefinition
const trap = Trapezoid as GpuShaderDefinition
const extra = (def: GpuShaderDefinition) => buildExtraSizeProps(def.props as never)

/** resolveDimensionalProp against the test canvas, centre origin. */
const resolve = (def: GpuShaderDefinition, prop: string, value: unknown, origin = 'center') =>
    resolveDimensionalProp(def.boundingBoxDeclaration, prop, value, origin as never, W, H, extra(def))

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    setUnitEnvironmentOverride({viewportWidth: VW, viewportHeight: VH, rem: 16})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    setUnitEnvironmentOverride(null)
    invalidateUnitEnvironment()
    warn.mockRestore()
})

describe('parsing', () => {
    it('reads every unit from a CSS-like string', () => {
        expect(parseLength('12px')).toEqual({value: 12, unit: 'px'})
        expect(parseLength('-10%')).toEqual({value: -10, unit: '%'})
        expect(parseLength('.5rem')).toEqual({value: 0.5, unit: 'rem'})
        expect(parseLength(' 40CW ')).toEqual({value: 40, unit: 'cw'})
        for (const u of ['ch', 'cmin', 'cmax', 'vw', 'vh', 'vmin', 'vmax', 'uv']) {
            expect(parseLength(`3${u}`)).toEqual({value: 3, unit: u})
        }
    })

    it('accepts a unitless "0" (any unit) and rejects every other unitless or unknown string', () => {
        expect(parseLength('0')).toEqual({value: 0, unit: 'px'})
        expect(parseLength('12')).toBeNull()
        expect(parseLength('12em')).toBeNull()
        expect(parseLength('center')).toBeNull()
        expect(parseLength('12 px px')).toBeNull()
    })

    it('normalizes objects and strings, leaves plain numbers to the legacy path', () => {
        expect(toDimensional({value: 5, unit: 'vh'})).toEqual({value: 5, unit: 'vh'})
        expect(toDimensional({value: 5, unit: 'em'})).toBeNull()
        expect(toDimensional('5vh')).toEqual({value: 5, unit: 'vh'})
        expect(toDimensional(0.5)).toBeNull()
    })

    it('flags values that depend on the viewport or root font size', () => {
        expect(usesViewportUnits('10vw')).toBe(true)
        expect(usesViewportUnits({value: 2, unit: 'rem'})).toBe(true)
        expect(usesViewportUnits({x: '10px', y: '5vmin'})).toBe(true)
        expect(usesViewportUnits({x: '10px', y: '5cw'})).toBe(false)
        expect(usesViewportUnits(0.5)).toBe(false)
    })
})

describe('lengthToPx', () => {
    const ctx = {canvasWidth: W, canvasHeight: H}
    const px = (s: string, axis: 'x' | 'y' | 'none' = 'x') => lengthToPx(parseLength(s)!, axis, ctx)

    it('converts canvas units', () => {
        expect(px('10cw')).toBe(80)
        expect(px('10ch')).toBe(40)
        expect(px('10cmin')).toBe(40)
        expect(px('10cmax')).toBe(80)
    })

    it('converts viewport units against the viewport, not the canvas', () => {
        expect(px('10vw')).toBe(144)
        expect(px('10vh')).toBe(90)
        expect(px('10vmin')).toBe(90)
        expect(px('10vmax')).toBe(144)
        expect(px('2rem')).toBe(32)
    })

    it('% measures the containing box on its axis, and has no meaning without one', () => {
        expect(px('25%', 'x')).toBe(200)
        expect(px('25%', 'y')).toBe(100)
        expect(px('25%', 'none')).toBeNull()
        // A containing box other than the canvas (the hook frames will use).
        expect(lengthToPx({value: 50, unit: '%'}, 'x', {...ctx, boxWidth: 300, boxHeight: 100})).toBe(150)
    })

    it('falls back to the canvas for viewport units and 16px for rem without a browser', () => {
        setUnitEnvironmentOverride({viewportWidth: 0, viewportHeight: 0, rem: 0})
        expect(px('10vw')).toBe(80)
        expect(px('10vh')).toBe(40)
        expect(px('1rem')).toBe(16)
    })

    it('measures the real viewport via a 100vw × 100vh probe when nothing is pinned', () => {
        setUnitEnvironmentOverride(null)
        invalidateUnitEnvironment()
        const v = lengthToPx({value: 100, unit: 'vw'}, 'x', ctx)
        expect(v).toBeGreaterThan(0)
        expect(document.querySelector('[data-shaders-viewport-probe]')).not.toBeNull()
    })
})

describe('legacy values resolve exactly as before', () => {
    it('plain numbers, {unit: uv} and {unit: px} are unchanged', () => {
        expect(resolve(rr, 'width', 0.35)).toBe(0.35)
        expect(resolve(rr, 'width', {value: 0.35, unit: 'uv'})).toBe(0.35)
        // px on a half-extent: full 200px → 200 / (2·400)
        expect(resolve(rr, 'width', {value: 200, unit: 'px'})).toBeCloseTo(0.25, 9)
        expect(resolve(rr, 'center', {x: 0.25, y: 0.75})).toEqual({x: 0.25, y: 0.75})
        expect(resolve(rr, 'center', {x: {value: 40, unit: 'px'}, y: 0.5})).toEqual({x: 0.55, y: 0.5})
        expect(resolve(circle, 'softness', {value: 20, unit: 'px'})).toBeCloseTo(0.05, 9)
    })

    it('a bare string px value is the same as the object form', () => {
        expect(resolve(rr, 'width', '200px')).toBe(resolve(rr, 'width', {value: 200, unit: 'px'}))
        expect(resolve(rr, 'center', {x: '40px', y: 0.5})).toEqual(resolve(rr, 'center', {x: {value: 40, unit: 'px'}, y: 0.5}))
    })

    it('keyword positions still reach the transform untouched', () => {
        expect(resolve(rr, 'center', {x: 'left', y: '10%'})).toEqual({x: 'left', y: 0.6})
    })
})

describe('shape sizes (RoundedRect — half-extents in canvas-height units)', () => {
    it('% on width / height measures the box width / height (CSS width/height)', () => {
        // width 50% → 400px full → half-UV 400 / (2·400) = 0.5
        expect(resolve(rr, 'width', '50%')).toBeCloseTo(0.5, 9)
        // height 50% → 200px full → 200 / 800 = 0.25
        expect(resolve(rr, 'height', '50%')).toBeCloseTo(0.25, 9)
    })

    it('every other unit converts through pixels', () => {
        expect(resolve(rr, 'width', '25cw')).toBeCloseTo(200 / 800, 9)
        expect(resolve(rr, 'width', '10vw')).toBeCloseTo(144 / 800, 9)
        expect(resolve(rr, 'height', '10vh')).toBeCloseTo(90 / 800, 9)
        expect(resolve(rr, 'height', '50cmin')).toBeCloseTo(200 / 800, 9)
        expect(resolve(rr, 'rounding', '1rem')).toBeCloseTo(16 / 400, 9)
        expect(resolve(rr, 'rounding', '5vmax')).toBeCloseTo(72 / 400, 9)
    })

    it('% on an axis-less prop is dropped (undefined → caller default) with one warning', () => {
        expect(resolve(rr, 'rounding', '10%')).toBeUndefined()
        expect(resolve(rr, 'rounding', '10%')).toBeUndefined()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(String(warn.mock.calls[0][0])).toContain('rounding')
    })
})

describe('shape sizes bound to both axes (Circle radius, Star radius)', () => {
    it('take every length unit but not %', () => {
        // Circle radius: canvas-height, px = full diameter → 10vmin = 90px → 90 / 400
        expect(resolve(circle, 'radius', '10vmin')).toBeCloseTo(0.225, 9)
        expect(resolve(circle, 'radius', '50%')).toBeUndefined()
        const star = Star as GpuShaderDefinition
        expect(resolve(star, 'radius', '100px')).toBeCloseTo(100 / 800, 9)
        expect(resolve(star, 'radius', '50%')).toBeUndefined()
    })
})

describe('positions — every unit is an inset from the origin edge', () => {
    it('centre origin: offsets from the middle, 0 = centred', () => {
        expect(resolve(rr, 'center', {x: '10%', y: '-20px'})).toEqual({x: 0.6, y: 0.45})
        expect(resolve(rr, 'center', {x: '0', y: '0'})).toEqual({x: 0.5, y: 0.5})
        const r = resolve(rr, 'center', {x: '10vw', y: '1rem'}) as {x: number; y: number}
        expect(r.x).toBeCloseTo(0.5 + 144 / 800, 9)
        expect(r.y).toBeCloseTo(0.5 + 16 / 400, 9)
    })

    it('edge origins: gap from that edge, shifted by the half-extent like px', () => {
        const props = {origin: 'top-left', center: {x: '10cw', y: '10%'}, width: '100px', height: '50px'}
        const out = resolveDimensionalProps(rr.boundingBoxDeclaration, props, W, H, extra(rr))
        // left edge 80px in, box 100px wide → centre at 130px; top 40px in, 50px tall → 65px
        expect(out.center.x).toBeCloseTo(130 / W, 9)
        expect(out.center.y).toBeCloseTo(65 / H, 9)
        // bottom-right: same gaps measured from the far edges
        const br = resolveDimensionalProps(rr.boundingBoxDeclaration, {...props, origin: 'bottom-right'}, W, H, extra(rr))
        expect(br.center.x).toBeCloseTo((W - 80 - 50) / W, 9)
        expect(br.center.y).toBeCloseTo((H - 40 - 25) / H, 9)
    })

    it('batch resolve drops an unsupported size so the consumer default applies', () => {
        const out = resolveDimensionalProps(rr.boundingBoxDeclaration, {width: '50%', rounding: '5%'}, W, H, extra(rr))
        expect(out.width).toBeCloseTo(0.5, 9)
        expect('rounding' in out).toBe(false)
    })
})

describe('marker-declared props and the other unit readers', () => {
    it('Trapezoid widths/heights know their axis (dimensionalAxis) — resolve and bounds agree', () => {
        expect(resolve(trap, 'bottomWidth', '50%')).toBeCloseTo(0.5, 9)
        expect(resolve(trap, 'height', '50%')).toBeCloseTo(0.25, 9)
        const b = trap.boundingBoxDeclaration!.computeBounds!(
            {bottomWidth: '50%', topWidth: 0.1, height: '25%', center: {x: 0.5, y: 0.5}}, W, H)
        expect(b.widthPx).toBeCloseTo(400, 9)
        expect(b.heightPx).toBeCloseTo(100, 9)
    })

    it('halfUvFromProp keeps its legacy rules and reads new units as the full size', () => {
        expect(halfUvFromProp(0.3, H, 0.35)).toBe(0.3)
        expect(halfUvFromProp({value: 0.3}, H, 0.35)).toBe(0.3)
        expect(halfUvFromProp({value: 200, unit: 'px'}, H, 0.35)).toBeCloseTo(0.25, 9)
        expect(halfUvFromProp('10vw', H, 0.35)).toBeCloseTo(144 / 800, 9)
        expect(halfUvFromProp('50%', H, 0.35, 'x', W)).toBeCloseTo(0.5, 9)
        expect(halfUvFromProp('50%', H, 0.35)).toBe(0.35) // no axis → fallback
    })

    it('Text: fontSize takes rem (no %), width % is of the box width', () => {
        const text = Text as GpuShaderDefinition
        expect(resolve(text, 'fontSize', '2rem')).toBeCloseTo(32 / 400, 9)
        expect(resolve(text, 'fontSize', '10%')).toBeUndefined()
        expect(resolve(text, 'width', '50%')).toBeCloseTo(0.5, 9)
        expect(resolve(text, 'width', '20vw')).toBeCloseTo(288 / 800, 9)
    })

    it('Repeater gaps: X % of the box width, Y % of the box height', () => {
        const rep = Repeater as GpuShaderDefinition
        const gapX = Object.keys(rep.props).find((k) => (rep.props as never as Record<string, {ui?: {label?: string}}>)[k].ui?.label === 'Gap X')!
        const gapY = Object.keys(rep.props).find((k) => (rep.props as never as Record<string, {ui?: {label?: string}}>)[k].ui?.label === 'Gap Y')!
        expect(resolve(rep, gapX, '10%')).toBeCloseTo(80 / 800, 9)
        expect(resolve(rep, gapY, '10%')).toBeCloseTo(40 / 400, 9)
    })

    it('Checkerboard cells (inverse count): a length sets one cell, % is unsupported', () => {
        const cb = Checkerboard as GpuShaderDefinition
        expect(resolve(cb, 'cells', '40px')).toBeCloseTo(10, 9)
        expect(resolve(cb, 'cells', '10ch')).toBeCloseTo(10, 9)
        expect(resolve(cb, 'cells', '10%')).toBeUndefined()
    })

    it('Group flow gap takes any unit along the main axis', () => {
        expect(resolveLayoutConfig({mode: 'column', gap: '10%'}, W, H)!.gapPx).toBeCloseTo(40, 9)
        expect(resolveLayoutConfig({mode: 'row', gap: '10%'}, W, H)!.gapPx).toBeCloseTo(80, 9)
        expect(resolveLayoutConfig({mode: 'row', gap: '1rem'}, W, H)!.gapPx).toBe(16)
        expect(resolveLayoutConfig({mode: 'row', gap: 12}, W, H)!.gapPx).toBe(12)
        expect(resolveLayoutConfig({mode: 'row', gap: {value: 0.1, unit: 'uv'}}, W, H)!.gapPx).toBeCloseTo(80, 9)
    })

    it('layout measures a unit-sized shape at its real pixel size', () => {
        const m = measureNode({type: 'RoundedRect', decl: rr.boundingBoxDeclaration, props: {width: '25%', height: '10vh'}} as never, W, H)
        expect(m).toEqual({widthPx: 200, heightPx: 90})
    })
})

// ── Through the real renderer (GPU-free: forced ready, no device) ──────────────────────────

const Root: GpuShaderDefinition = {name: 'Root', props: {} as never, fragment: (() => ({})) as never}
const meta = (): NodeMetadata => ({blendMode: 'normal', opacity: undefined, renderOrder: 0}) as NodeMetadata

function mountShape(def: GpuShaderDefinition, props: Record<string, unknown>, dims = {width: W, height: H}) {
    const reactive: Record<string, unknown> = {}
    for (const [name, cfg] of Object.entries(def.props)) reactive[name] = (cfg as {default: unknown}).default
    Object.assign(reactive, props)
    const uniforms = createGpuUniformsMap(def as never, reactive, 'shape') as unknown as GpuUniformsMap
    const r = shaderRendererGPU()
    r.__testing.setTestReady(dims)
    r.registerNode('root', Root.fragment, null, meta(), {} as never, Root)
    r.registerNode('shape', def.fragment, 'root', meta(), uniforms as never, def)
    const node = r.__testing.getNodeRegistry().nodes.get('shape')!
    return {r, node}
}

describe('renderer', () => {
    it('resolves string units at registration, keeping the raw value for re-resolution', () => {
        const {node} = mountShape(rr, {width: '50%', height: '10vh', rounding: '1rem', center: {x: '10%', y: 0.5}})
        expect(node.uniforms.width.value).toBeCloseTo(0.5, 9)
        expect(node.uniforms.height.value).toBeCloseTo(90 / 800, 9)
        expect(node.uniforms.rounding.value).toBeCloseTo(16 / 400, 9)
        expect(node.uniforms.center.value).toEqual({x: 0.6, y: 0.5})
        expect(node.uniforms.width._rawDimensional).toBe('50%')
        // The resolved values are what the transforms pack — plain numbers, never strings.
        expect(typeof node.uniforms.width.value).toBe('number')
    })

    it('an unsupported % falls back to the prop default', () => {
        const {node} = mountShape(rr, {rounding: '10%'})
        expect(node.uniforms.rounding.value).toBe((rr.props as Record<string, {default: unknown}>).rounding.default)
    })

    it('runtime updates take units too', () => {
        const {r, node} = mountShape(rr, {})
        r.updateUniformValue('shape', 'width', '25cw')
        expect(node.uniforms.width.value).toBeCloseTo(200 / 800, 9)
        r.updateUniformValue('shape', 'rounding', '3%')
        expect(node.uniforms.rounding.value).toBe((rr.props as Record<string, {default: unknown}>).rounding.default)
    })

    it('re-resolves viewport units on a window resize that leaves the canvas alone', () => {
        const {r, node} = mountShape(rr, {width: '10vw', height: '50%'})
        expect(node.uniforms.width.value).toBeCloseTo(144 / 800, 9)
        setUnitEnvironmentOverride({viewportWidth: 1000, viewportHeight: 700, rem: 16})
        r.__testing.reresolveViewportUnits()
        expect(node.uniforms.width.value).toBeCloseTo(100 / 800, 9)
        expect(node.uniforms.height.value).toBeCloseTo(0.25, 9) // canvas-relative, unchanged
    })

    it('canvas and % units follow the canvas size', () => {
        const {r, node} = mountShape(rr, {width: '50%', height: '10cmin'})
        r.__testing.setTestReady({width: 1000, height: 500})
        r.updateUniformValue('shape', 'origin', 'center') // triggers a dimensional re-resolve
        // width 50% → 500px → 500 / 1000; height 10cmin → 50px → 50 / 1000
        expect(node.uniforms.width.value).toBeCloseTo(0.5, 9)
        expect(node.uniforms.height.value).toBeCloseTo(0.05, 9)
    })
})
