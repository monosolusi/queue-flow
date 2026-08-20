import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LicenseBanner } from './LicenseBanner';
import type { CallerLicenseSlice } from '../api/types';

const slice = (
  state: CallerLicenseSlice['state'],
  restrictsNewTickets = state === 'RESTRICTED',
): CallerLicenseSlice => ({ state, restrictsNewTickets });

describe('LicenseBanner (caller)', () => {
  it('renders nothing when the license is valid', () => {
    const { container } = render(<LicenseBanner license={slice('VALID')} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([undefined, null])('renders nothing when the license is %p', (license) => {
    // Older core-api, or its boot window. Unknown is not a problem to announce.
    const { container } = render(<LicenseBanner license={license} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each<CallerLicenseSlice['state']>(['EXPIRING_SOON', 'GRACE', 'MISMATCH_GRACE'])(
    'warns in %s while making clear the panel still works',
    (state) => {
      render(<LicenseBanner license={slice(state)} />);
      expect(screen.getByRole('status')).toHaveTextContent(/tetap berfungsi normal/i);
    },
  );

  it('explains the kiosk symptom when tickets are restricted', () => {
    // Staff are the ones a customer will ask why the kiosk stopped printing;
    // naming that symptom is the entire reason this banner exists.
    render(<LicenseBanner license={slice('RESTRICTED')} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(/kiosk sedang tidak bisa mencetak tiket baru/i);
    expect(banner).toHaveTextContent(/antrean yang sudah ada tetap bisa dilayani/i);
  });

  it('trusts restrictsNewTickets over the state name', () => {
    // The server owns the ladder; the client must not re-derive it from a name.
    render(<LicenseBanner license={slice('GRACE', true)} />);
    expect(screen.getByRole('status')).toHaveTextContent(/tidak bisa mencetak tiket baru/i);
  });
});
