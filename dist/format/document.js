export function makeLoadedDocument(base, pageData, zip, opc) {
    return {
        ...base,
        pages: pageData.map(p => ({ id: p.id, name: p.name, kind: p.kind, width: p.width, height: p.height, sourcePath: p.sourcePath, diagnostics: p.diagnostics })),
        pageData,
        zip,
        opc
    };
}
