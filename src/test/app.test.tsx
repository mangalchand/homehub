import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { reset } from '../api/demo'
import App from '../App'

function renderApp(route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('FamilyHub app', () => {
  beforeEach(() => {
    localStorage.clear()
    reset()
  })

  it('renders the dashboard with seeded stats', async () => {
    renderApp('/')
    expect(await screen.findByText(/Today.s schedule/i)).toBeInTheDocument()
    expect(screen.getByText('Chores leaderboard')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /groceries/i }).length).toBeGreaterThan(0)
  })

  it('navigates to groceries and adds an item', async () => {
    const user = userEvent.setup()
    renderApp('/groceries')
    expect(await screen.findByText('Bananas')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Add an item…'), 'Bread')
    await user.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() => expect(screen.getByText('Bread')).toBeInTheDocument())
  })

  it('checks off a chore on the chores page', async () => {
    const user = userEvent.setup()
    renderApp('/chores')
    const row = (await screen.findByText('Empty the dishwasher')).closest('.row')!
    const btn = row.querySelector('.check')!
    await user.click(btn as HTMLElement)
    await waitFor(() => expect(screen.getByText('Empty the dishwasher')).toHaveClass('done'))
  })

  it('opens the new reminder dialog', async () => {
    const user = userEvent.setup()
    renderApp('/reminders')
    await user.click(await screen.findByRole('button', { name: /new reminder/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Add reminder')).toBeInTheDocument()
  })
})
