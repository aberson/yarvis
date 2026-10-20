// Minimal typing for html-to-text 10.x (the package ships no declarations). Only the surface
// connectors/gmail.ts uses is declared.
declare module "html-to-text" {
  export interface SelectorDefinition {
    selector: string;
    format?: string;
    options?: Record<string, unknown>;
  }

  export interface HtmlToTextOptions {
    wordwrap?: number | false | null;
    preserveNewlines?: boolean;
    selectors?: SelectorDefinition[];
    limits?: Record<string, unknown>;
  }

  export function convert(html: string, options?: HtmlToTextOptions): string;
}
