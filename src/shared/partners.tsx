// Logos of the two organisations behind the prayer station, linked to their
// own sites. The files are served from this site (never hotlinked), and the
// links carry no referrer, so following one tells them nothing about the page.

const PARTNERS = [
  { name: '24-7 Prayer', href: 'https://www.24-7prayer.com', logo: '/logos/24-7-prayer.svg', width: 703, height: 154 },
  {
    name: 'Order of the Mustard Seed',
    href: 'https://orderofthemustardseed.com',
    logo: '/logos/order-of-the-mustard-seed.svg',
    width: 578,
    height: 172,
  },
] as const;

export function Partners() {
  return (
    <footer class="partners">
      {PARTNERS.map((p) => (
        <a key={p.name} href={p.href} target="_blank" rel="noopener noreferrer" aria-label={`${p.name} (opens in a new tab)`}>
          <img src={p.logo} alt={p.name} width={p.width} height={p.height} />
        </a>
      ))}
    </footer>
  );
}
