import { stripLinks } from "./sms.ts";

// What Textbelt must never see until the key is verified for links.

test("removes URLs, www. and bare domains, keeping the words", () => {
  const text = stripLinks(
    "Try https://example.com/menu?x=1 or www.example.org, and see example.net/path (or not).",
  );
  expect(text).toBe("Try or, and see (or not).");
  expect(text).not.toMatch(/https?:|www\.|example\./);
});

test("a research report's source list goes, not its body", () => {
  const report =
    "Research: heat pumps\n\nThey work down to 40F [1][2].\n\nSources:\n[1] https://a.example.com/x\n[2] https://b.example.org";
  expect(stripLinks(report)).toBe("Research: heat pumps\n\nThey work down to 40F [1][2].");
});

test("empty brackets a link leaves behind are tidied", () => {
  expect(stripLinks("The menu (https://example.com) is long")).toBe("The menu is long");
  expect(stripLinks("Plain text with no links.")).toBe("Plain text with no links.");
});
