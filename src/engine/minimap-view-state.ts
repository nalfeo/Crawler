export interface MinimapViewState {
  centerX: number;
  centerY: number;
  zoom: number;
  mapWidth: number;
  mapHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface MinimapZoomLimits {
  minZoom: number;
  maxZoom: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampMinimapViewState(view: MinimapViewState): MinimapViewState {
  const halfW = view.viewportWidth / (2 * view.zoom);
  const halfH = view.viewportHeight / (2 * view.zoom);

  let centerX = view.centerX;
  let centerY = view.centerY;

  if (view.mapWidth * view.zoom <= view.viewportWidth) {
    centerX = view.mapWidth / 2;
  } else {
    centerX = clamp(centerX, halfW, view.mapWidth - halfW);
  }

  if (view.mapHeight * view.zoom <= view.viewportHeight) {
    centerY = view.mapHeight / 2;
  } else {
    centerY = clamp(centerY, halfH, view.mapHeight - halfH);
  }

  return { ...view, centerX, centerY };
}

export function zoomMinimapAtPoint(
  view: MinimapViewState,
  requestedZoom: number,
  focusX: number,
  focusY: number,
  limits: MinimapZoomLimits,
): MinimapViewState {
  const zoom = clamp(requestedZoom, limits.minZoom, limits.maxZoom);
  const localX = focusX - view.viewportWidth / 2;
  const localY = focusY - view.viewportHeight / 2;
  const mapFocusX = view.centerX + localX / view.zoom;
  const mapFocusY = view.centerY + localY / view.zoom;
  const centerX = mapFocusX - localX / zoom;
  const centerY = mapFocusY - localY / zoom;
  return clampMinimapViewState({ ...view, zoom, centerX, centerY });
}

export function panMinimapByScreenDelta(
  view: MinimapViewState,
  deltaScreenX: number,
  deltaScreenY: number,
): MinimapViewState {
  return clampMinimapViewState({
    ...view,
    centerX: view.centerX - deltaScreenX / view.zoom,
    centerY: view.centerY - deltaScreenY / view.zoom,
  });
}
