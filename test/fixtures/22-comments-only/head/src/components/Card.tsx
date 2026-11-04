import type { ReactNode } from 'react'

/** Props of a card: a title and its content. */
export interface CardProps {
  title: string
  children: ReactNode
}

/**
 * A titled section. Used by the home and products pages.
 */
export function Card({ title, children }: CardProps) {
  // The heading keeps the page outline: one h2 per card.
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  )
}
