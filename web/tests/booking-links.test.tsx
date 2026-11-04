// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { BookingActions } from '../src/BookingActions';
import './setup';
afterEach(cleanup);
it('LINK01 exposes a sourced booking link before agreement', () => {
  render(<BookingActions option={{bookingLink:{url:'https://www.opentable.com/r/test',sourceUrl:'https://restaurant.example/reservations',retrievedAt:'2026-11-03T19:00:00Z',provider:'OpenTable',provenance:'official_link'}} as any}/>);
  expect(screen.getByRole('link',{name:/Reserve/}).getAttribute('href')).toBe('https://www.opentable.com/r/test');
  expect(screen.getByText(/Availability and booking terms/)).toBeTruthy();
});
it('LINK02 labels website and listing fallback without treating evidence as booking', () => {
  render(<BookingActions option={{reservationUrl:'https://restaurant.example/menu',officialWebsiteUrl:'https://restaurant.example',directory:{profileUrl:'https://www.yelp.com/biz/test'}} as any}/>);
  expect(screen.getByRole('link',{name:'Visit website'}).getAttribute('href')).toBe('https://restaurant.example');
  expect(screen.queryByRole('link',{name:/Reserve/})).toBeNull();
  expect(screen.queryByRole('link',{name:/menu/})).toBeNull();
});
it('LINK02 labels listing and call fallback separately', () => {
  render(<BookingActions option={{directory:{profileUrl:'https://www.yelp.com/biz/test',phone:'+13125551212'}} as any}/>);
  expect(screen.getByRole('link',{name:'View listing'})).toBeTruthy();
  expect(screen.getByRole('link',{name:'Call restaurant'}).getAttribute('href')).toBe('tel:+13125551212');
});
