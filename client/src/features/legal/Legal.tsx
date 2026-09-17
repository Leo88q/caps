// /legal/:doc — the two static documents (terms, privacy) whose text lives in shared/lib/legal.ts.
//
// Kept deliberately dumb: no data fetching, no wallet, no query client. A legal page that needs an RPC
// to render is a legal page that fails in the exact regions where someone most needs to read it, and it
// is the page a regulator, a store reviewer and a journalist open first.
import { useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { legalDoc, LEGAL_IDS, LEGAL_EFFECTIVE, LEGAL_REVIEWED, RESTRICTED_REGIONS, AGE_MIN, type LegalDoc } from '@/shared/lib/legal';
import { useT, useLocale } from '@/shared/i18n';
import { APP_NAME } from '@/app/config';

export default function Legal() {
  const { doc } = useParams();
  // `/legal` with no document is the URL a footer link or a store listing ends up with after a typo in
  // the path, and /terms + /privacy are aliases for the same reason: neither should 404.
  if (!doc) return <Navigate to="/legal/terms" replace />;
  const d = legalDoc(doc);
  return d ? <Document doc={d} /> : <Unknown />;
}

function Document({ doc }: { doc: LegalDoc }) {
  const t = useT();
  const { locale } = useLocale();

  useEffect(() => { document.title = `${doc.title} · ${APP_NAME}`; }, [doc.title]);

  return (
    <div className="page stack" style={{ maxWidth: 760 }}>
      <nav className="row" style={{ gap: 12 }} aria-label={t('legal.title')}>
        {LEGAL_IDS.map((id) => (
          <Link key={id} to={`/legal/${id}`} aria-current={id === doc.slug ? 'page' : undefined} className={id === doc.slug ? 'active' : ''}>
            {t(id === 'terms' ? 'legal.terms' : 'legal.privacy')}
          </Link>
        ))}
      </nav>

      <h1 className="page-title">{doc.title}</h1>
      <p className="muted small">{t('legal.updated', { date: LEGAL_EFFECTIVE })} · {locale.toUpperCase()}</p>

      {!LEGAL_REVIEWED && (
        <div className="warn" role="note">
          <strong>{t('legal.draftTitle')}</strong>
          <p className="small" style={{ marginTop: 4 }}>{t('legal.draftBody')}</p>
        </div>
      )}

      <p>{doc.intro}</p>

      {doc.sections.map((s) => (
        <section key={s.h} className="card stack">
          <h2 style={{ fontSize: 18, margin: 0 }}>{s.h}</h2>
          {s.p.map((paragraph, i) => <p key={i} style={{ margin: 0 }}>{paragraph}</p>)}
        </section>
      ))}

      <div className="card stack muted small">
        <p style={{ margin: 0 }}>{t('legal.canonical')}</p>
        <p style={{ margin: 0 }}>
          {t('legal.ages')} {AGE_MIN}+ · {t('legal.noSaleIn')} {RESTRICTED_REGIONS.join(', ')} · <Link to="/verify">{t('legal.verify')}</Link>
        </p>
      </div>
    </div>
  );
}

function Unknown() {
  const t = useT();
  return (
    <div className="page stack" style={{ maxWidth: 560 }}>
      <h1 className="page-title">404</h1>
      <p className="page-sub">{t('legal.notFound')}</p>
      <p>{LEGAL_IDS.map((id) => <Link key={id} to={`/legal/${id}`} style={{ marginRight: 12 }}>{id}</Link>)}</p>
    </div>
  );
}
