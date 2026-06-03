/**
 * Lab runner entry point.
 * Loads the lab specified by ?lab= query param, or shows the lab index.
 */

const labParam = new URLSearchParams(window.location.search).get('lab');

if (labParam) {
  console.log(`[Labs] Loading lab: ${labParam}`);
  // Lab registry will be populated as labs are created
} else {
  const container = document.getElementById('lab-canvas');
  if (container) {
    container.innerHTML = `
      <div style="padding: 2rem;">
        <h1>🧪 Crawler Labs</h1>
        <p>No lab selected. Use <code>?lab=&lt;name&gt;</code> to load a lab.</p>
        <h2>Available Labs</h2>
        <ul id="lab-list">
          <li><em>No labs registered yet. Create one in src/labs/</em></li>
        </ul>
      </div>
    `;
  }
}
