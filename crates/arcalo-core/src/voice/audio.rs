//! Audio of a recording: whatever the device delivers is mixed down to mono and resampled to
//! 16 kHz (what Whisper needs), written to a WAV file while recording (nothing is lost when the
//! app ends), and stored as FLAC afterwards (lossless, about half the size, plays in every
//! webview). Also the level meter and reading WAV files (the test hook feeds one).

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::error::{Error, IoAt, Result};
use crate::{tr, trf};

/// Sample rate of recordings and of Whisper's input.
pub const RATE: u32 = 16_000;

/// Interleaved frames → mono (average of the channels).
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved.chunks(channels).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect()
}

/// Streaming resampler to [`RATE`]: averages the input over each output interval (a box filter,
/// enough against aliasing for speech) or repeats samples when the input rate is lower.
#[derive(Debug, Clone)]
pub struct Resampler {
    step: f64,
    t: f64,
    acc: f32,
    n: u32,
}

impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        Self { step: f64::from(input_rate.max(1)) / f64::from(RATE), t: 0.0, acc: 0.0, n: 0 }
    }

    pub fn process(&mut self, mono: &[f32], out: &mut Vec<f32>) {
        for &x in mono {
            self.acc += x;
            self.n += 1;
            self.t += 1.0;
            while self.t >= self.step {
                out.push(if self.n > 0 { self.acc / self.n as f32 } else { x });
                self.acc = 0.0;
                self.n = 0;
                self.t -= self.step;
            }
        }
    }
}

/// Whole buffer to 16 kHz mono.
pub fn to_16k_mono(interleaved: &[f32], rate: u32, channels: usize) -> Vec<f32> {
    let mono = downmix(interleaved, channels);
    if rate == RATE {
        return mono;
    }
    let mut out = Vec::with_capacity(mono.len() * RATE as usize / rate.max(1) as usize + 1);
    Resampler::new(rate).process(&mono, &mut out);
    out
}

/// Adds `other` into `into` (system audio into the microphone), limited to [-1, 1].
pub fn mix_into(into: &mut [f32], other: &[f32]) {
    for (a, b) in into.iter_mut().zip(other) {
        *a = (*a + *b).clamp(-1.0, 1.0);
    }
}

/// Level for the meter, 0..1 on a dB scale (−60 dB … 0 dB).
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
    if rms <= 1e-6 {
        return 0.0;
    }
    ((20.0 * rms.log10() + 60.0) / 60.0).clamp(0.0, 1.0)
}

fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

fn header(samples: u32) -> [u8; 44] {
    let data = samples * 2;
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(RATE * 2).to_le_bytes());
    h[32..34].copy_from_slice(&2u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data.to_le_bytes());
    h
}

/// 16 kHz mono 16-bit WAV written while recording; the header is brought up to date on every
/// [`WavWriter::sync`] and on [`WavWriter::finish`].
pub struct WavWriter {
    out: BufWriter<File>,
    path: PathBuf,
    samples: u32,
}

impl WavWriter {
    pub fn create(path: &Path) -> Result<Self> {
        let mut out = BufWriter::new(File::create(path).at(path)?);
        out.write_all(&header(0)).at(path)?;
        Ok(Self { out, path: path.to_owned(), samples: 0 })
    }

    pub fn write(&mut self, samples: &[f32]) -> Result<()> {
        let bytes: Vec<u8> = samples.iter().flat_map(|s| to_i16(*s).to_le_bytes()).collect();
        self.out.write_all(&bytes).at(&self.path)?;
        self.samples = self.samples.saturating_add(samples.len() as u32);
        Ok(())
    }

    pub fn samples(&self) -> u32 {
        self.samples
    }

    /// Writes the buffered samples and the current length into the header.
    pub fn sync(&mut self) -> Result<()> {
        self.out.flush().at(&self.path)?;
        let f = self.out.get_mut();
        f.seek(SeekFrom::Start(0)).at(&self.path)?;
        f.write_all(&header(self.samples)).at(&self.path)?;
        f.seek(SeekFrom::End(0)).at(&self.path)?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<u32> {
        self.sync()?;
        self.out.get_ref().sync_all().at(&self.path)?;
        Ok(self.samples)
    }
}

/// A WAV file's format and its samples (interleaved, −1..1).
pub struct Wav {
    pub rate: u32,
    pub channels: usize,
    pub samples: Vec<f32>,
}

fn bad_wav() -> Error {
    Error::State(
        tr!(
            "Keine lesbare WAV-Datei (PCM 8/16/24/32 Bit oder Float)",
            "Not a readable WAV file (PCM 8/16/24/32 bit or float)"
        )
        .into(),
    )
}

/// WAV sample data of `format` (1: PCM, 3: float) with `bits` as samples −1..1; `None` for
/// other formats.
fn decode_pcm(format: u16, bits: u16, data: &[u8]) -> Option<Vec<f32>> {
    Some(match (format, bits) {
        (1, 8) => data.iter().map(|b| (f32::from(*b) - 128.0) / 128.0).collect(),
        (1, 16) => data.chunks_exact(2).map(|c| f32::from(i16::from_le_bytes([c[0], c[1]])) / 32768.0).collect(),
        (1, 24) => data
            .chunks_exact(3)
            .map(|c| (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f32 / 8_388_608.0)
            .collect(),
        (1, 32) => data
            .chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2_147_483_648.0)
            .collect(),
        (3, 32) => data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect(),
        _ => return None,
    })
}

/// Reads a WAV file: PCM with 8, 16, 24 or 32 bits, or 32-bit float.
pub fn read_wav(path: &Path) -> Result<Wav> {
    let mut bytes = Vec::new();
    BufReader::new(File::open(path).at(path)?).read_to_end(&mut bytes).at(path)?;
    parse_wav(&bytes)
}

pub fn parse_wav(bytes: &[u8]) -> Result<Wav> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad_wav());
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let mut pos = 12;
    let mut fmt: Option<(u16, usize, u32, u16)> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32_at(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            let mut format = u16_at(body);
            // WAVE_FORMAT_EXTENSIBLE: the sub format's first two bytes.
            if format == 0xFFFE && body + 26 <= bytes.len() {
                format = u16_at(body + 24);
            }
            fmt = Some((format, u16_at(body + 2) as usize, u32_at(body + 4), u16_at(body + 14)));
        } else if id == b"data" {
            let (format, channels, rate, bits) = fmt.ok_or_else(bad_wav)?;
            // A header written before the length was known says 0 or too much: up to the end.
            let end = if len == 0 || body + len > bytes.len() { bytes.len() } else { body + len };
            let samples = decode_pcm(format, bits, &bytes[body..end]).ok_or_else(bad_wav)?;
            if channels == 0 || rate == 0 {
                return Err(bad_wav());
            }
            return Ok(Wav { rate, channels, samples });
        }
        pos = body + len + (len & 1);
    }
    Err(bad_wav())
}

/// Reads a recording (16 kHz mono WAV) for Whisper.
pub fn read_16k(path: &Path) -> Result<Vec<f32>> {
    let w = read_wav(path)?;
    Ok(to_16k_mono(&w.samples, w.rate, w.channels))
}

/// The 16-bit value of a sample −1..1, as a 16-bit file stores it (`x · 32768`).
fn pcm16(x: f32) -> i16 {
    (x * 32768.0).round().clamp(-32768.0, 32767.0) as i16
}

/// A 16-bit sample as Whisper takes it (−1..1, the inverse of [`pcm16`]).
pub fn pcm_to_f32(pcm: &[i16]) -> Vec<f32> {
    pcm.iter().map(|s| f32::from(*s) / 32768.0).collect()
}

/// The pieces a long recording is transcribed in (Whisper copies its whole input a few times
/// over, so an hour at once needs several hundred MB): about `window` samples each, cut at the
/// quietest 100 ms within `search` samples before the mark (not in the middle of a word). The
/// last piece takes up to a minute more rather than leaving a scrap.
pub fn windows(pcm: &[i16], window: usize, search: usize) -> Vec<std::ops::Range<usize>> {
    let step = RATE as usize / 10;
    let tail = RATE as usize * 60;
    let mut out = Vec::new();
    let mut start = 0;
    while pcm.len() - start > window + tail {
        let mark = start + window;
        let mut at = mark.saturating_sub(search).max(start + step);
        let mut cut = (u64::MAX, mark);
        while at + step <= mark {
            let energy: u64 = pcm[at..at + step].iter().map(|&s| (i64::from(s) * i64::from(s)) as u64).sum();
            // The later of equally quiet spots: pieces as long as they may be.
            if energy <= cut.0 {
                cut = (energy, at + step / 2);
            }
            at += step;
        }
        out.push(start..cut.1);
        start = cut.1;
    }
    out.push(start..pcm.len());
    out
}

/// Collects 16 kHz mono 16-bit samples from blocks of any rate and channel count. 16-bit keeps
/// a long recording at 2 bytes a sample (Whisper gets `f32` piece by piece, see [`windows`]).
struct Pcm16k {
    channels: usize,
    resampler: Option<Resampler>,
    resampled: Vec<f32>,
    out: Vec<i16>,
}

impl Pcm16k {
    /// `frames`: the expected number of input frames (the result is allocated once, so it is
    /// never copied while growing).
    fn new(rate: u32, channels: usize, frames: usize) -> Self {
        let expected = (frames as u64 * u64::from(RATE) / u64::from(rate.max(1))) as usize + 16;
        Self {
            channels,
            resampler: (rate != RATE).then(|| Resampler::new(rate)),
            resampled: Vec::new(),
            out: Vec::with_capacity(expected),
        }
    }

    fn push(&mut self, interleaved: &[f32]) {
        let mono = downmix(interleaved, self.channels);
        match &mut self.resampler {
            None => self.out.extend(mono.iter().map(|&x| pcm16(x))),
            Some(r) => {
                self.resampled.clear();
                r.process(&mono, &mut self.resampled);
                self.out.extend(self.resampled.iter().map(|&x| pcm16(x)));
            }
        }
    }
}

/// Reads a voice note's audio (FLAC as stored, or WAV) as 16 kHz mono 16-bit samples for
/// Whisper, a block at a time: only the result is held in memory.
pub fn read_16k_pcm(path: &Path) -> Result<Vec<i16>> {
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("flac")) {
        read_flac_pcm(path)
    } else {
        read_wav_pcm(path)
    }
}

fn read_flac_pcm(path: &Path) -> Result<Vec<i16>> {
    let bad = |e: claxon::Error| Error::State(trf!("Keine lesbare FLAC-Datei ({e})", "Not a readable FLAC file ({e})"));
    let mut reader = claxon::FlacReader::open(path).map_err(bad)?;
    let info = reader.streaminfo();
    if info.channels == 0 || info.sample_rate == 0 {
        return Err(bad_wav());
    }
    let channels = info.channels as usize;
    let mut pcm = Pcm16k::new(info.sample_rate, channels, info.samples.unwrap_or(0) as usize);
    // As stored by `encode_flac`: the samples as they are.
    let direct = info.sample_rate == RATE && channels == 1 && info.bits_per_sample == 16;
    let scale = (1u64 << info.bits_per_sample.saturating_sub(1).min(31)) as f32;
    let mut blocks = reader.blocks();
    let mut buffer = Vec::new();
    let mut interleaved = Vec::new();
    while let Some(block) = blocks.read_next_or_eof(buffer).map_err(bad)? {
        if direct {
            pcm.out.extend(block.channel(0).iter().map(|&v| v as i16));
        } else {
            interleaved.clear();
            for i in 0..block.duration() {
                for ch in 0..block.channels() {
                    interleaved.push(block.sample(ch, i) as f32 / scale);
                }
            }
            pcm.push(&interleaved);
        }
        buffer = block.into_buffer();
    }
    Ok(pcm.out)
}

fn read_wav_pcm(path: &Path) -> Result<Vec<i16>> {
    let file = File::open(path).at(path)?;
    let size = file.metadata().at(path)?.len();
    let mut input = BufReader::with_capacity(1 << 16, file);
    let mut head = [0u8; 12];
    if input.read_exact(&mut head).is_err() || &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return Err(bad_wav());
    }
    let mut pos = 12u64;
    let mut fmt: Option<(u16, usize, u32, u16)> = None;
    loop {
        let mut chunk = [0u8; 8];
        input.read_exact(&mut chunk).map_err(|_| bad_wav())?;
        let len = u64::from(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]));
        let body = pos + 8;
        let pad = len & 1;
        if &chunk[0..4] == b"data" {
            let (format, channels, rate, bits) = fmt.ok_or_else(bad_wav)?;
            if channels == 0 || rate == 0 {
                return Err(bad_wav());
            }
            // A header written before the length was known says 0 or too much: up to the end.
            let end = if len == 0 || body + len > size { size } else { body + len };
            let len = end - body;
            return read_pcm_data(&mut input.take(len), len, (format, channels, rate, bits), path);
        }
        if &chunk[0..4] == b"fmt " && len >= 16 {
            let mut b = vec![0u8; len.min(64) as usize];
            input.read_exact(&mut b).map_err(|_| bad_wav())?;
            let u16_at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
            let mut format = u16_at(0);
            // WAVE_FORMAT_EXTENSIBLE: the sub format's first two bytes.
            if format == 0xFFFE && b.len() >= 26 {
                format = u16_at(24);
            }
            fmt = Some((format, u16_at(2) as usize, u32::from_le_bytes([b[4], b[5], b[6], b[7]]), u16_at(14)));
            input.seek_relative((len - b.len() as u64 + pad) as i64).at(path)?;
        } else {
            input.seek_relative((len + pad) as i64).at(path)?;
        }
        pos = body + len + pad;
    }
}

/// The `data` chunk (`len` bytes) of a WAV file (`format`, channels, rate, bits) as 16 kHz mono
/// 16-bit.
fn read_pcm_data(
    data: &mut impl Read,
    len: u64,
    (format, channels, rate, bits): (u16, usize, u32, u16),
    path: &Path,
) -> Result<Vec<i16>> {
    let bytes = match (format, bits) {
        (1, 8) => 1,
        (1, 16) => 2,
        (1, 24) => 3,
        (1, 32) | (3, 32) => 4,
        _ => return Err(bad_wav()),
    };
    let frame = bytes * channels;
    let mut buf = vec![0u8; frame * 4096];
    let mut pcm = Pcm16k::new(rate, channels, (len / frame as u64) as usize);
    // A recording of [`WavWriter`]: the samples as they are.
    let direct = (format, bits, channels, rate) == (1, 16, 1, RATE);
    loop {
        let mut n = 0;
        while n < buf.len() {
            match data.read(&mut buf[n..]).at(path)? {
                0 => break,
                read => n += read,
            }
        }
        // A frame cut off at the end is left out.
        let whole = n - n % frame;
        if whole == 0 {
            break;
        }
        let block = &buf[..whole];
        if direct {
            pcm.out.extend(block.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])));
        } else if let Some(samples) = decode_pcm(format, bits, block) {
            pcm.push(&samples);
        }
        if n < buf.len() {
            break;
        }
    }
    Ok(pcm.out)
}

/// Samples in a recording file of `len` bytes written by [`WavWriter`] (16-bit mono after the
/// 44-byte header), whatever its header says.
pub fn wav_samples(len: u64) -> u32 {
    (len.saturating_sub(44) / 2).min(u64::from(u32::MAX)) as u32
}

/// A recording cut off by a crash: its header gets the length of what is in the file (the
/// header is only brought up to date now and then while recording). Returns the samples.
pub fn repair_wav(path: &Path) -> Result<u32> {
    let len = std::fs::metadata(path).at(path)?.len();
    let samples = wav_samples(len);
    let mut f = std::fs::OpenOptions::new().write(true).open(path).at(path)?;
    // An odd last byte (half a sample) is cut.
    f.set_len(44 + u64::from(samples) * 2).at(path)?;
    f.seek(SeekFrom::Start(0)).at(path)?;
    f.write_all(&header(samples)).at(path)?;
    f.sync_all().at(path)?;
    Ok(samples)
}

/// Feeds a recording's 16-bit samples to the FLAC encoder block by block (no full copy in memory).
struct WavSource {
    input: BufReader<File>,
    remaining: usize,
    buf: Vec<u8>,
    ints: Vec<i32>,
}

impl flacenc::source::Source for WavSource {
    fn channels(&self) -> usize {
        1
    }
    fn bits_per_sample(&self) -> usize {
        16
    }
    fn sample_rate(&self) -> usize {
        RATE as usize
    }
    fn read_samples<F: flacenc::source::Fill>(
        &mut self,
        block_size: usize,
        dest: &mut F,
    ) -> std::result::Result<usize, flacenc::error::SourceError> {
        let n = block_size.min(self.remaining);
        self.buf.resize(n * 2, 0);
        self.input.read_exact(&mut self.buf).map_err(flacenc::error::SourceError::from_io_error)?;
        self.remaining -= n;
        self.ints.clear();
        self.ints.extend(self.buf.chunks_exact(2).map(|c| i32::from(i16::from_le_bytes([c[0], c[1]]))));
        dest.fill_interleaved(&self.ints)?;
        Ok(n)
    }
    fn len_hint(&self) -> Option<usize> {
        Some(self.remaining)
    }
}

/// Frames encoded at a time (in parallel) before they are written: about a minute of audio, so
/// the encoded stream is never held in memory as a whole (that took about 650 MB an hour).
const FLAC_BATCH: usize = 256;

fn flac_failed(e: impl std::fmt::Display) -> Error {
    Error::State(trf!("FLAC-Kodierung fehlgeschlagen: {e}", "FLAC encoding failed: {e}"))
}

/// The bytes of `stream` (without frames: the `fLaC` marker and the stream info).
fn flac_bytes(stream: &flacenc::component::Stream) -> Result<Vec<u8>> {
    use flacenc::component::BitRepr;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).map_err(|e| flac_failed(format!("{e:?}")))?;
    Ok(sink.into_inner())
}

/// Encodes a recording written by [`WavWriter`] as FLAC into `flac`; returns its size. The
/// frames go to a temp file as they are encoded; the stream info (length, checksum) is written
/// over its placeholder at the end, then the file is renamed into place.
pub fn encode_flac(wav: &Path, flac: &Path) -> Result<u64> {
    use flacenc::component::{BitRepr, Stream};
    use flacenc::error::Verify;
    use flacenc::source::{Context, FrameBuf, Source};
    let mut input = BufReader::new(File::open(wav).at(wav)?);
    let len = input.get_ref().metadata().at(wav)?.len();
    input.seek(SeekFrom::Start(44)).at(wav)?;
    let samples = (len.saturating_sub(44) / 2) as usize;
    if samples == 0 {
        return Err(Error::State(tr!("Die Aufnahme ist leer", "The recording is empty").into()));
    }
    let config = flacenc::config::Encoder::default().into_verified().map_err(|(_, e)| flac_failed(e))?;
    let block = config.block_size;
    let mut source = WavSource { input, remaining: samples, buf: Vec::new(), ints: Vec::new() };
    let mut stream = Stream::new(RATE as usize, 1, 16).map_err(flac_failed)?;
    stream.stream_info_mut().set_block_sizes(block, block).map_err(flac_failed)?;
    let dir = flac.parent().ok_or_else(|| Error::State(tr!("Kein Zielordner", "No target folder").into()))?;
    std::fs::create_dir_all(dir).at(dir)?;
    let name = flac.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.tmp"));
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 8);
    let written = (|| -> Result<u64> {
        let mut out = BufWriter::new(File::create(&tmp).at(&tmp)?);
        let head = flac_bytes(&stream)?;
        out.write_all(&head).at(&tmp)?;
        let mut size = head.len() as u64;
        let mut context = Context::new(16, 1);
        let mut sink = flacenc::bitsink::ByteSink::new();
        loop {
            let mut bufs: Vec<(usize, FrameBuf)> = Vec::with_capacity(FLAC_BATCH);
            while bufs.len() < FLAC_BATCH {
                let mut fb = FrameBuf::with_size(1, block).map_err(flac_failed)?;
                if source.read_samples(block, &mut (&mut fb, &mut context)).map_err(flac_failed)? == 0 {
                    break;
                }
                bufs.push((context.current_frame_number().unwrap_or(0), fb));
            }
            if bufs.is_empty() {
                break;
            }
            let info = stream.stream_info();
            let per = bufs.len().div_ceil(workers);
            let frames: Vec<_> = std::thread::scope(|s| {
                let jobs: Vec<_> = bufs
                    .chunks(per)
                    .map(|part| {
                        let config = &config;
                        s.spawn(move || {
                            part.iter()
                                .map(|(n, fb)| {
                                    flacenc::encode_fixed_size_frame(config, fb, *n, info).map_err(|e| e.to_string())
                                })
                                .collect::<Vec<_>>()
                        })
                    })
                    .collect();
                jobs.into_iter().flat_map(|j| j.join().unwrap_or_default()).collect()
            });
            if frames.len() != bufs.len() {
                return Err(flac_failed("encoder thread"));
            }
            for frame in frames {
                let frame = frame.map_err(flac_failed)?;
                stream.stream_info_mut().update_frame_info(&frame);
                sink.clear();
                frame.write(&mut sink).map_err(|e| flac_failed(format!("{e:?}")))?;
                out.write_all(sink.as_slice()).at(&tmp)?;
                size += sink.as_slice().len() as u64;
            }
        }
        stream.stream_info_mut().set_md5_digest(&context.md5_digest());
        stream.stream_info_mut().set_total_samples(samples);
        let mut file = out.into_inner().map_err(|e| Error::file(&tmp, e.into_error()))?;
        file.seek(SeekFrom::Start(0)).at(&tmp)?;
        file.write_all(&flac_bytes(&stream)?).at(&tmp)?;
        file.sync_all().at(&tmp)?;
        Ok(size)
    })();
    let size = written.and_then(|size| std::fs::rename(&tmp, flac).map(|()| size).map_err(|e| Error::file(flac, e)));
    if size.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    size
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, secs: f32, channels: usize) -> Vec<f32> {
        let n = (rate as f32 * secs) as usize;
        (0..n)
            .flat_map(|i| {
                let v = (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5;
                std::iter::repeat_n(v, channels)
            })
            .collect()
    }

    #[test]
    fn resampling_and_downmix() {
        assert_eq!(downmix(&[0.2, 0.4, -1.0, 1.0], 2), [0.3f32, 0.0]);
        assert_eq!(to_16k_mono(&tone(48_000, 1.0, 2), 48_000, 2).len(), 16_000);
        assert!(to_16k_mono(&tone(44_100, 1.0, 1), 44_100, 1).len().abs_diff(16_000) <= 1);
        assert_eq!(to_16k_mono(&tone(8_000, 1.0, 1), 8_000, 1).len(), 16_000);
        // Streaming in odd chunks gives the same as all at once.
        let input = tone(44_100, 0.5, 1);
        let mut r = Resampler::new(44_100);
        let mut a = Vec::new();
        for c in input.chunks(333) {
            r.process(c, &mut a);
        }
        assert_eq!(a, to_16k_mono(&input, 44_100, 1));
    }

    #[test]
    fn level_meter_scale() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 100]), 0.0);
        assert!((level(&[1.0, -1.0]) - 1.0).abs() < 1e-6);
        let quiet = level(&[0.01; 100]);
        assert!(quiet > 0.2 && quiet < 0.4, "{quiet}");
        let mut a = [0.6f32, -0.6];
        mix_into(&mut a, &[0.6, 0.1]);
        assert_eq!(a, [1.0, -0.5]);
    }

    #[test]
    fn wav_round_trip_and_flac() {
        let dir = std::env::temp_dir().join(format!("arcalo-audio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("rec.wav");
        let mut w = WavWriter::create(&wav).unwrap();
        let t = tone(RATE, 2.0, 1);
        w.write(&t[..10_000]).unwrap();
        w.sync().unwrap();
        // Readable while still recording.
        assert_eq!(read_16k(&wav).unwrap().len(), 10_000);
        w.write(&t[10_000..]).unwrap();
        assert_eq!(w.finish().unwrap(), 32_000);
        let back = read_16k(&wav).unwrap();
        assert_eq!(back.len(), 32_000);
        assert!((back[100] - t[100]).abs() < 1e-3);

        let flac = dir.join("rec.flac");
        let size = encode_flac(&wav, &flac).unwrap();
        let bytes = std::fs::read(&flac).unwrap();
        assert_eq!(&bytes[..4], b"fLaC");
        assert_eq!(bytes.len() as u64, size);
        assert!(size < std::fs::metadata(&wav).unwrap().len());
        // The stored FLAC reads back for „Neu transkribieren“, sample for sample as the WAV.
        let again = read_16k_pcm(&flac).unwrap();
        assert_eq!(again.len(), 32_000);
        assert_eq!(again, read_16k_pcm(&wav).unwrap());
        assert!((pcm_to_f32(&again)[100] - t[100]).abs() < 1e-3);
        assert_eq!(pcm_to_f32(&again), back, "Whisper gets what it got before");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn flac_is_written_as_it_is_encoded() {
        use flacenc::component::BitRepr;
        use flacenc::error::Verify;
        let dir = std::env::temp_dir().join(format!("arcalo-flac-stream-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("rec.wav");
        let mut w = WavWriter::create(&wav).unwrap();
        // More than two batches of frames, the last one short; speech-like: a tone with noise.
        let mut seed = 7u32;
        let t: Vec<f32> = (0..(FLAC_BATCH * 4096 * 2 + 5_000))
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (i as f32 * 0.05).sin() * 0.3 + ((seed >> 16) as f32 / 65_536.0 - 0.5) * 0.1
            })
            .collect();
        w.write(&t).unwrap();
        w.finish().unwrap();
        let flac = dir.join("rec.flac");
        let size = encode_flac(&wav, &flac).unwrap();
        // The same bytes as encoding it all at once (as before), header and checksum included.
        let config = flacenc::config::Encoder::default().into_verified().unwrap();
        let mut input = BufReader::new(File::open(&wav).unwrap());
        input.seek(SeekFrom::Start(44)).unwrap();
        let source = WavSource { input, remaining: t.len(), buf: Vec::new(), ints: Vec::new() };
        let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size).unwrap();
        let mut sink = flacenc::bitsink::ByteSink::new();
        stream.write(&mut sink).unwrap();
        let bytes = std::fs::read(&flac).unwrap();
        assert_eq!(bytes.len() as u64, size);
        assert!(bytes == sink.as_slice(), "the streamed FLAC differs from the one-shot encoding");
        assert_eq!(read_16k_pcm(&flac).unwrap(), read_16k_pcm(&wav).unwrap());
        assert!(!dir.join(".rec.flac.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn long_recordings_are_cut_where_it_is_quiet() {
        let rate = RATE as usize;
        // 25 minutes of "speech" with a pause of 300 ms at 9:55 and one at 19:52.
        let mut pcm: Vec<i16> = (0..rate * 60 * 25).map(|i| if i % 7 < 4 { 8_000 } else { -8_000 }).collect();
        for at in [rate * 595, rate * 1192] {
            pcm[at..at + rate * 3 / 10].fill(0);
        }
        let w = windows(&pcm, rate * 600, rate * 15);
        assert_eq!(w.len(), 3, "{w:?}");
        assert_eq!(w[0].start, 0);
        assert!(w[0].end >= rate * 595 && w[0].end <= rate * 595 + rate * 3 / 10, "{w:?}");
        assert_eq!(w[1].start, w[0].end);
        assert!(w[1].end >= rate * 1192 && w[1].end <= rate * 1192 + rate * 3 / 10, "{w:?}");
        assert_eq!((w[2].start, w[2].end), (w[1].end, pcm.len()));
        // Without a pause: cut at the mark.
        let loud = vec![1_000i16; rate * 60 * 12];
        let w = windows(&loud, rate * 600, rate * 15);
        assert_eq!(w.len(), 2);
        assert!(w[0].end <= rate * 600 && w[0].end > rate * 585);
        // Up to a minute more stays one piece; short and empty ones too.
        assert_eq!(windows(&loud[..rate * 660], rate * 600, rate * 15), vec![0..rate * 660]);
        assert_eq!(windows(&[], rate * 600, rate * 15), vec![0..0]);
    }

    #[test]
    fn a_recording_cut_off_by_a_crash_is_repaired() {
        let dir = std::env::temp_dir().join(format!("arcalo-voice-crash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("rec-1.wav");
        let mut w = WavWriter::create(&wav).unwrap();
        let t = tone(RATE, 1.0, 1);
        w.write(&t[..4_000]).unwrap();
        w.sync().unwrap();
        w.write(&t[4_000..]).unwrap();
        // The app dies: buffered samples reach the file, the header still says 4000.
        drop(w);
        let mut f = std::fs::OpenOptions::new().append(true).open(&wav).unwrap();
        f.write_all(&[7]).unwrap(); // half a sample
        drop(f);
        assert_eq!(wav_samples(std::fs::metadata(&wav).unwrap().len()), 16_000);
        assert_eq!(repair_wav(&wav).unwrap(), 16_000);
        assert_eq!(std::fs::metadata(&wav).unwrap().len(), 44 + 32_000);
        assert_eq!(read_16k(&wav).unwrap().len(), 16_000);
        assert_eq!(wav_samples(10), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_other_wav_formats() {
        // Stereo 48 kHz float, as a test file might be.
        let samples = tone(48_000, 0.25, 2);
        let mut b = Vec::new();
        let data = (samples.len() * 4) as u32;
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&3u16.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&48_000u32.to_le_bytes());
        b.extend_from_slice(&(48_000u32 * 8).to_le_bytes());
        b.extend_from_slice(&8u16.to_le_bytes());
        b.extend_from_slice(&32u16.to_le_bytes());
        b.extend_from_slice(b"LIST");
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(b"abc\0");
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data.to_le_bytes());
        for s in &samples {
            b.extend_from_slice(&s.to_le_bytes());
        }
        let w = parse_wav(&b).unwrap();
        assert_eq!((w.rate, w.channels, w.samples.len()), (48_000, 2, samples.len()));
        // Read block by block for Whisper: the same as all at once.
        let dir = std::env::temp_dir().join(format!("arcalo-audio-float-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("float.wav");
        std::fs::write(&file, &b).unwrap();
        let whole: Vec<i16> = to_16k_mono(&w.samples, w.rate, w.channels).iter().map(|&x| pcm16(x)).collect();
        let pcm = read_16k_pcm(&file).unwrap();
        assert_eq!(pcm.len(), 4_000);
        assert!(pcm.iter().zip(&whole).all(|(a, b)| a.abs_diff(*b) <= 1));
        std::fs::write(&file, b"RIFF0000WAVEdata").unwrap();
        assert!(read_16k_pcm(&file).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(parse_wav(b"RIFF0000WAVE").is_err());
        assert!(parse_wav(b"not a wav").is_err());
    }
}
