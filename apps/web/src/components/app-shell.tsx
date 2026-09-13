import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

const navigation = [
  { href: "/missions", label: "Missions", glyph: "M" },
  { href: "/credit", label: "Credit", glyph: "C" },
  { href: "/providers", label: "Providers", glyph: "P" },
  { href: "/payments", label: "Payments", glyph: "X" },
  { href: "/audit", label: "Audit", glyph: "A" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Koven dashboard home">
          <span className="brand-mark" aria-hidden="true">
            <Image src="/koven-mark.png" alt="" width={38} height={38} priority />
          </span>
          <span>
            <strong>Koven</strong>
            <small>Agent payment console</small>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          {navigation.map(item => (
            <Link className="nav-link" href={item.href} key={item.href}>
              <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="network-card">
          <span className="network-dot" aria-hidden="true" />
          <div>
            <strong>Hedera testnet</strong>
            <small>Network evidence enabled</small>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">Autonomous settlement</span>
            <strong>Mission control</strong>
          </div>
          <span className="live-pill"><span aria-hidden="true" /> Live · 2s</span>
        </header>
        {children}
      </main>
    </div>
  );
}
