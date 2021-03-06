import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AragonApi, useApi, useAppState } from '@aragon/api-react'
import appStateReducer from './app-state-reducer'
import { usePanelState } from './utils-hooks'
import { useVotes } from './vote-hooks'
import { VOTE_YEA } from './vote-types'
import { EMPTY_CALLSCRIPT } from './evmscript-utils'

// Get the vote currently selected, or null otherwise.
export function useSelectedVote(votes) {
  const [selectedVoteId, setSelectedVoteId] = useState('-1')
  const { ready } = useAppState()

  // The memoized vote currently selected.
  const selectedVote = useMemo(() => {
    // The `ready` check prevents a vote to be selected
    // until the app state is fully ready.
    if (!ready || selectedVoteId === '-1') {
      return null
    }
    return votes.find(vote => vote.voteId === selectedVoteId) || null
  }, [selectedVoteId, votes, ready])

  return [
    selectedVote,

    // setSelectedVoteId() is exported directly: since `selectedVoteId` is
    // set in the `selectedVote` dependencies, it means that the useMemo()
    // will be updated every time `selectedVoteId` changes.
    setSelectedVoteId,
  ]
}

// Create a new vote
export function useCreateVoteAction(onDone) {
  const api = useApi()
  return useCallback(
    question => {
      if (api) {
        api.newVote(EMPTY_CALLSCRIPT, question)
        onDone()
      }
    },
    [api, onDone]
  )
}

// Vote (the action) on a vote
export function useVoteAction(onDone) {
  const api = useApi()
  return useCallback(
    (voteId, voteType, executesIfDecided = true) => {
      api.vote(voteId, voteType === VOTE_YEA, executesIfDecided)
      onDone()
    },
    [api, onDone]
  )
}

// Execute a vote
export function useExecuteAction(onDone) {
  const api = useApi()
  return useCallback(
    voteId => {
      api.executeVote(voteId)
      onDone()
    },
    [api, onDone]
  )
}

// Handles the state of the selected vote panel.
export function useSelectedVotePanel(selectedVote, selectVote) {
  const selectedVoteId = selectedVote ? selectedVote.voteId : '-1'

  // Only deselect the current vote when the panel is fully closed, so that
  // the panel doesn’t appear empty while being closed.
  const onDidClose = useCallback(() => {
    selectVote('-1')
  }, [selectVote])

  const selectedVotePanel = usePanelState({ onDidClose })

  // This is to help the React Hooks linter.
  const { requestOpen, didOpen } = selectedVotePanel

  // When the selected vote changes, open the selected vote panel.
  useEffect(() => {
    if (selectedVoteId !== '-1' && !didOpen) {
      requestOpen()
    }
  }, [selectedVoteId, requestOpen, didOpen])

  return selectedVotePanel
}

// Handles the main logic of the app.
export function useAppLogic() {
  const votes = useVotes()
  const [selectedVote, selectVote] = useSelectedVote(votes)
  const newVotePanel = usePanelState()
  const selectedVotePanel = useSelectedVotePanel(selectedVote, selectVote)

  const actions = {
    createVote: useCreateVoteAction(() => {
      newVotePanel.requestClose()
    }),
    vote: useVoteAction(() => {
      selectedVotePanel.requestClose()
    }),
    execute: useExecuteAction(() => {
      selectedVotePanel.requestClose()
    }),
  }

  return {
    votes,
    selectVote,
    selectedVote,
    actions,

    newVotePanel: {
      ...newVotePanel,
      // ensure there is only one panel opened at a time
      visible: newVotePanel.visible && !selectedVotePanel.visible,
    },
    selectedVotePanel: {
      ...selectedVotePanel,
      visible: selectedVotePanel.visible && !newVotePanel.visible,
    },
  }
}

export function AppLogicProvider({ children }) {
  return <AragonApi reducer={appStateReducer}>{children}</AragonApi>
}
