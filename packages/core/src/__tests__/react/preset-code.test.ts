import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import ts from 'typescript'
import {describe, expect, it} from 'vitest'

// Exercise the source template before CI builds the framework packages. Default filtering,
// numeric rounding and bounding-box reduction are unrelated to string serialization.
const template = readFileSync(resolve(__dirname, '../../../../react/src/utils/generatePresetCode.template.ts'), 'utf8').replace('__COMPONENT_LIST__', '')
const exports: Record<string, any> = {}
new Function('exports', '__SHADER_METADATA__', 'roundPresetForExport', 'reduceBoundingBoxForExport',
    ts.transpileModule(template, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText
)(exports, {}, (value: unknown) => value, (value: unknown) => value)

function roundTrip(components: unknown[]) {
    const code = exports.generatePresetCode({components})
    const result = ts.transpileModule(code, {
        fileName: 'preset.tsx', reportDiagnostics: true,
        compilerOptions: {jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS}
    })
    expect(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), code).toEqual([])
    const output: Record<string, any> = {}
    const jsx = (type: unknown, props: unknown) => ({type, props})
    const require = (name: string) => name === 'react/jsx-runtime'
        ? {jsx, jsxs: jsx}
        : new Proxy({}, {get: (_, key) => key})
    new Function('exports', 'require', result.outputText)(output, require)
    return output.default().props.children
}

describe('React preset string serialization', () => {
    it.each(['He said "hello" and <bye/>', 'Line one\nLine two\t\\path', '&quot; &amp;', '{"a":"b"}'])('preserves text %j', text => {
        expect(roundTrip([{type: 'Text', props: {text}}]).props.text).toBe(text)
    })

    it('keeps referenced ids and string driver values intact', () => {
        const id = 'layer "one" &amp;'
        const children = roundTrip([
            {type: 'Text', id, props: {text: 'source'}},
            {type: 'Text', props: {maskSource: id, opacity: {type: 'map', source: id, min: 0, max: 1}}}
        ])
        expect(children[0].props.id).toBe(id)
        expect(children[1].props.maskSource).toBe(id)
        expect(children[1].props.opacity.source).toBe(id)
    })

    it('preserves JSON config strings while leaving real objects and arrays as objects', () => {
        const shape = '{"type":"circleSDF","radius":0.3}'
        const stops = [{color: '#fff', position: 0}, {color: '#000', position: 1}]
        const child = roundTrip([{type: 'Glass', props: {shape, colorStops: stops, transform: {edges: 'wrap', rotation: 30}}}])
        expect(child.props.shape).toBe(shape)
        expect(child.props.colorStops).toEqual(stops)
        expect(child.props.transform).toEqual({edges: 'wrap', rotation: 30})
    })
})
