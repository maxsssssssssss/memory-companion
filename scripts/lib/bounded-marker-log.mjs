export function appendBoundedMarkerLog(state, chunk, options) {
  const combined = state.output + String(chunk);
  return {
    markerSeen: state.markerSeen || combined.includes(options.marker),
    output: combined.length > options.maxLength
      ? combined.slice(-options.maxLength)
      : combined
  };
}
