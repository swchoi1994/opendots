import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { dataDir } from './data-dir'

test('dataDir defaults to ./.opendots and follows OPENDOTS_DATA_DIR', () => {
  assert.equal(dataDir({}), resolve('.opendots'))
  assert.equal(dataDir({ OPENDOTS_DATA_DIR: '' }), resolve('.opendots'), 'an empty value is the default, not the cwd')
  assert.equal(dataDir({ OPENDOTS_DATA_DIR: '/srv/opendots' }), '/srv/opendots')
  assert.equal(dataDir({ OPENDOTS_DATA_DIR: 'data' }), resolve('data'))
})
