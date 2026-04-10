export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (a === null || b === null) {
    return false;
  }

  if (typeof a !== "object" || typeof b !== "object") {
    return false;
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }

  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) {
      return false;
    }

    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqualJson(a[index], (b as unknown[])[index])) {
        return false;
      }
    }

    return true;
  }

  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }

    if (!deepEqualJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }

  return true;
}

export function stabilizeJsonValue<T>(previous: T | undefined, next: T): T {
  if (previous !== undefined && deepEqualJson(previous, next)) {
    return previous;
  }

  return next;
}

export function isDocumentVisible(): boolean {
  return typeof document === "undefined" ? true : document.visibilityState !== "hidden";
}
