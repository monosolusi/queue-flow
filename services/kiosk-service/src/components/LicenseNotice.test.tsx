import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LicenseNotice } from './LicenseNotice';
import type { KioskLicenseSlice } from '../api/types';

const slice = (
  state: KioskLicenseSlice['state'],
  restrictsNewTickets = state === 'RESTRICTED',
): KioskLicenseSlice => ({ state, restrictsNewTickets });

describe('LicenseNotice', () => {
  it('tells the visitor to find staff when no ticket can be issued', () => {
    render(<LicenseNotice license={slice('RESTRICTED')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/menghubungi petugas/i);
  });

  it('never uses the word "lisensi" — that is the operator\'s problem, not the customer\'s', () => {
    // A visitor cannot fix a license and should not be shown a commercial
    // dispute. If this ever fails, the copy has drifted toward the wrong reader.
    const { container } = render(<LicenseNotice license={slice('RESTRICTED')} />);
    expect(container.textContent?.toLowerCase()).not.toContain('lisensi');
    expect(container.textContent?.toLowerCase()).not.toContain('licen');
  });

  it.each<KioskLicenseSlice['state']>(['VALID', 'EXPIRING_SOON', 'GRACE', 'MISMATCH_GRACE'])(
    'renders nothing in %s — the store still works and the warning is the manager\'s',
    (state) => {
      const { container } = render(<LicenseNotice license={slice(state)} />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('renders nothing when the license is unknown', () => {
    // Older core-api, or its boot window. Unknown is not restricted.
    const { container } = render(<LicenseNotice license={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('trusts restrictsNewTickets over the state name', () => {
    // The server owns the ladder. If a future state restricts, the kiosk must
    // honour it without this file having to learn the new name.
    render(<LicenseNotice license={slice('GRACE', true)} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
