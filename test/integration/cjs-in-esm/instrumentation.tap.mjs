/*
 * Copyright 2023 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

// eslint-disable-next-line node/no-extraneous-import
import { test } from 'tap'
import helper from '../../lib/agent_helper.js'
import generateApp from './helpers.mjs'
import axios from 'axios'

test('Registering CommonJS instrumentation in ES Module project', async (t) => {
  const agent = helper.instrumentMockedAgent()
  const app = await generateApp()
  const server = app.listen(0)

  t.teardown(async () => {
    helper.unloadAgent(agent)
    server && server.close()
  })

  agent.on('transactionFinished', (transaction) => {
    /**
     * When using the node 14/16/18 ESM loader, this app would cause transactions
     * with a name like this:
     * WebTransaction/Expressjs/GET//weird/weird/weird/weird/looking/path/looking/path
     */
    t.equal(
      transaction.name,
      'WebTransaction/Expressjs/GET//weird/looking/path',
      'transaction has expected name'
    )
  })

  await axios.get(`http://localhost:${server.address().port}/weird/looking/path`)
})