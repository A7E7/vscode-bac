// TS twin of FBacDiagnostics / FBacDiagnostic / FBacSourceLocation in the C++
// plugin. Diagnostic codes (BAC1xxx, BAC2xxx, …) are wire-stable across both
// implementations — that's the whole point of the port: AST-only diagnostics
// produced here in TS are identical to what the UE-side validator would emit.

export interface BacSourceLocation {
  line:   number; // 1-based
  column: number; // 1-based
  offset: number; // 0-based
}

export const NO_LOCATION: BacSourceLocation = { line: 0, column: 0, offset: 0 };

export type BacSeverity = 'error' | 'warning' | 'info';

export interface BacRelatedNote {
  message:  string;
  location: BacSourceLocation;
}

export interface BacDiagnostic {
  severity: BacSeverity;
  message:  string;
  location: BacSourceLocation;
  code:     string;          // empty if uncategorized
  notes?:   BacRelatedNote[];
  hint?:    string;
  fixes?:   string[];
}

export class BacDiagnostics {
  readonly items: BacDiagnostic[] = [];

  add(severity: BacSeverity, message: string, location: BacSourceLocation = NO_LOCATION, code = ''): void {
    this.items.push({ severity, message, location, code });
  }

  error(message: string, location: BacSourceLocation = NO_LOCATION, code = ''): void {
    this.add('error', message, location, code);
  }

  warning(message: string, location: BacSourceLocation = NO_LOCATION, code = ''): void {
    this.add('warning', message, location, code);
  }

  hasErrors(): boolean {
    return this.items.some(d => d.severity === 'error');
  }
}
