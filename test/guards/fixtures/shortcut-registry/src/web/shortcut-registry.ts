export function register(): void {
  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
    }
  });
}
