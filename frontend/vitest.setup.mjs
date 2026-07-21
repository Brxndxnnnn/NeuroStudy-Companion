import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia — several components (ThemeToggle) read
// it to detect the OS color scheme preference.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
