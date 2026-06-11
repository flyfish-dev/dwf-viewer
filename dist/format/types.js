export function diag(level, code, message, source) {
    return source === undefined ? { level, code, message } : { level, code, message, source };
}
export function actionableDiagnostics(diagnostics) {
    return (diagnostics ?? []).filter(d => d.level !== 'info');
}
