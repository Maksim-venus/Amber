export function install(): void {
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "k") {
      event.preventDefault();
    }
  });
}

export function onListKey(event: KeyboardEvent): void {
  if (event.metaKey) {
    event.stopPropagation();
  }
}

export function onEnter(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
  }
}
