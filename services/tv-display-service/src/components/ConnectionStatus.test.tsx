import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionStatusBadge } from './ConnectionStatus';

describe('ConnectionStatusBadge (AC1 aria-live)', () => {
  afterEach(cleanup);

  it.each([
    ['open', 'Terhubung'],
    ['connecting', 'Menghubungkan…'],
    ['closed', 'Terputus'],
  ] as const)(
    'status %s announces via a polite live region + label text (AC1)',
    (status, label) => {
      render(<ConnectionStatusBadge status={status} />);
      const region = screen.getByRole('status');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region).toHaveClass(`connection-status--${status}`);
      expect(region).toHaveTextContent(label);
    },
  );
});