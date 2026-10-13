export const MUSIC_KINDS={piano:'鋼琴',violin:'小提琴',rain:'雨聲',other:'其他'};
export const DEFAULT_PIANO_DURATION_CAP=300;
export const DEFAULT_PIANO_CAPTION=`### Global Metadata
A complete, extended acoustic solo piano composition lasting approximately four minutes, within a three-to-five-minute range. Gentle contemporary classical music for a quiet portrait photography slideshow. Use a warm grand piano in an intimate room, rounded hammer attacks, natural sustain and restrained pedal resonance. Keep an unhurried, even pulse and comfortable dynamics throughout. Develop a recognizable melody through several connected variations, a contrasting middle passage and a spacious return. Sustain the musical development for the full performance before resolving the ending. The piano is the only sound source; exclude other instruments, percussion, electronic layers and environmental recordings.

### Vocal Details
Strictly instrumental from beginning to end. The right hand carries the lead melody, with piano accompaniment providing harmony and pulse. No speech, singing, humming, chanting, choir, vocal textures or breath samples. Every section label and time range below is silent arrangement metadata and must never be spoken or sung.

### Arrangement
Intro, approximately 0:00-0:25: introduce a short, lyrical middle-register motif over widely spaced low piano notes. Leave small spaces between phrases and let the acoustic resonance establish the room.

Theme, approximately 0:25-1:10: expand the motif into longer, balanced phrases. Introduce gentle broken chords in the left hand while keeping the melody clearly above the accompaniment.

First variation, approximately 1:10-1:55: shift parts of the melody into a slightly higher register, add occasional answering piano phrases and vary the harmonic movement. Maintain the established pulse and develop the phrases continuously.

Contrasting middle, approximately 1:55-2:40: move briefly into a more reflective harmonic color. Thin the accompaniment, then rebuild it with a light flowing pattern. Let a modest dynamic rise come entirely from the pianist's touch.

Return and second variation, approximately 2:40-3:30: bring back the opening melody with warmer harmony and a fuller but still gentle left-hand pattern. Use fresh phrase endings and small melodic variations to sustain the long-form development.

Outro, approximately 3:30-4:00: gradually remove the flowing accompaniment, return to single low notes and softly restate the opening motif. Settle into a quiet final piano chord and allow its natural decay to finish the complete performance.`;

export function musicWorkflow(id,{caption,durationCap=DEFAULT_PIANO_DURATION_CAP,seed=7}) {
  return {
    '1':{class_type:'MiniMaxMusic3Generate',inputs:{lyrics:'[Intro]\n[Instrumental]\n[Solo]\n[Instrumental]\n[Outro]',instructions:caption,seed,duration_cap_seconds:durationCap,release_gpu_after_generate:true}},
    '2':{class_type:'SaveAudioMP3',inputs:{audio:['1',0],filename_prefix:`PhotoCreate/_gallery_music/${id}/music`,quality:'V0'}},
  };
}
