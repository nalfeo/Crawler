export function transitionToLocalSource(state) {
  state.source = 'local';
  state.selectedRun = null;
  state.jobPhases = null;
  return state;
}
