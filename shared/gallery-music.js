export const MUSIC_KINDS={piano:'鋼琴',violin:'小提琴',rain:'雨聲',other:'其他'};
export const DEFAULT_PIANO_CAPTION=`### Global Metadata
A strictly instrumental acoustic solo piano miniature in a gentle contemporary classical style, suitable for a quiet portrait photography slideshow. The only sound source is a warm grand piano recorded in a small, softly reverberant room. Use an unhurried, even pulse, a rounded touch and moderate dynamics. Develop a peaceful opening into a warmer, slightly fuller middle, then return to the opening atmosphere. Maintain one continuous piano performance from first note to last decay. Keep the acoustic timbre consistent across the piece, with recognizable hammer attacks, natural sustain and restrained pedal resonance. Exclude every instrument other than piano, along with samples, percussion, sound effects and environmental recordings.

### Vocal Details
Instrumental solo piano throughout, with a completely silent vocal track. Only piano notes may carry melody, harmony and rhythm. Speech, singing, humming, chanting, choir, vocal textures and breath samples are excluded at every point, including transitions and the ending. The arrangement descriptions are silent instructions for the pianist.

### Arrangement
Opening: play a sparse, lyrical piano motif in the middle register. Support it with single low piano notes placed at the beginnings of phrases. Let the notes decay naturally, preserving space between phrases.

Middle: repeat the motif with small melodic variations and introduce a light, flowing left-hand piano pattern. Make the harmony warmer while avoiding heavy bass or rapid passagework. Keep all embellishments on the piano keyboard. The melody should remain clear and approachable, and the dynamics should stay gentle even as the accompaniment becomes fuller.

Closing: thin the left-hand pattern back to single notes and return to the opening motif. Gradually soften the piano touch. End with a settled piano chord and its natural decay, keeping the same quiet acoustic room sound as the opening. The complete performance remains a piano solo.`;

export function musicWorkflow(id,{caption,durationCap=90,seed=7}) {
  return {
    '1':{class_type:'MiniMaxMusic3Generate',inputs:{lyrics:'[Intro]\n[Instrumental]\n[Solo]\n[Instrumental]\n[Outro]',instructions:caption,seed,duration_cap_seconds:durationCap,release_gpu_after_generate:true}},
    '2':{class_type:'SaveAudioMP3',inputs:{audio:['1',0],filename_prefix:`PhotoCreate/_gallery_music/${id}/music`,quality:'V0'}},
  };
}
