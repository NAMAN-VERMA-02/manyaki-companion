import { describe, expect, it } from 'vitest'
import { moodFromReply, parseIntent } from '../shared/intents'

describe('parseIntent (English + Hinglish)', () => {
  it('opens folders, websites and apps', () => {
    expect(parseIntent('Mera Downloads folder khol do please')).toEqual({ tool: 'open_folder', arg: 'Downloads' })
    expect(parseIntent('open my college notes folder')).toEqual({ tool: 'open_folder', arg: 'college notes' })
    expect(parseIntent('youtube khol do')).toEqual({ tool: 'open_website', arg: 'youtube' })
    expect(parseIntent('search recursion in java')).toEqual({ tool: 'open_website', arg: 'recursion in java' })
    expect(parseIntent('Can you open VS Code?')).toEqual({ tool: 'open_app', arg: 'VS Code' })
    expect(parseIntent('spotify chalao')).toEqual({ tool: 'open_app', arg: 'spotify' })
  })
  it('handles focus timers', () => {
    expect(parseIntent("let's focus for 40 minutes")).toEqual({ tool: 'start_focus', arg: 40 })
    expect(parseIntent('25 min ka padhai timer laga do')).toEqual({ tool: 'start_focus', arg: 25 })
    expect(parseIntent('start focus')).toEqual({ tool: 'start_focus', arg: 25 })
    expect(parseIntent('timer band karo')).toEqual({ tool: 'stop_focus' })
  })
  it('handles goals, names and memories', () => {
    expect(parseIntent('add goal: finish DSA sheet')).toEqual({ tool: 'add_goal', arg: 'finish DSA sheet' })
    expect(parseIntent('goal 2 done')).toEqual({ tool: 'complete_goal', arg: '2' })
    expect(parseIntent('my name is Naman')).toEqual({ tool: 'set_user_name', arg: 'Naman' })
    expect(parseIntent('remember that my exam is on Nov 3')).toEqual({ tool: 'remember', arg: 'my exam is on Nov 3' })
  })
  it('leaves normal chat alone', () => {
    expect(parseIntent('aaj padhai ka mood nahi hai yaar')).toBeNull()
    expect(parseIntent('explain recursion simply')).toBeNull()
    expect(parseIntent('I am tired')).toBeNull()
  })
})

describe('moodFromReply', () => {
  it('matches mood to what she says', () => {
    expect(moodFromReply('Yay, you did it!', null).action).toBe('cheer')
    expect(moodFromReply("Aww, don't worry, it's okay.", null).emotion).toBe('worried')
    expect(moodFromReply('Imagine a story that repeats itself.', null).action).toBe('think')
  })
})
