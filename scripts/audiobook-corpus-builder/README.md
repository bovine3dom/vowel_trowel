# Audiobook Corpus Builder / Aligner

This uv project is for building audiobook-derived corpus candidates for Vowel Trowel.

The Python code here should stay managed by uv. Forced alignment is handled as an external tool via Montreal Forced Aligner (MFA), installed in an isolated micromamba environment. This avoids Conda shell initialization and keeps the main shell startup fast.

## Montreal Forced Aligner With Micromamba

Do not run `micromamba shell init` unless you explicitly want shell activation support. The workflow below uses `micromamba run`, so no shell startup files need to change.

Create an MFA environment from conda-forge:

```fish
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba create -y -n mfa -c conda-forge montreal-forced-aligner
```

Verify the installation:

```fish
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba run -n mfa mfa version
```

Run MFA commands without activating the environment:

```fish
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba run -n mfa mfa --help
```

## MFA Models

List available models:

```fish
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba run -n mfa mfa model list acoustic
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba run -n mfa mfa model list dictionary
```

Download the models needed for a language:

```fish
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba run -n mfa mfa model download acoustic english_gb_arpa
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba run -n mfa mfa model download dictionary english_gb_arpa
```

Use the closest available model for the corpus language/accent. For British English audiobook material, check MFA's current model list before choosing a dictionary/acoustic model.

## Alignment Command Shape

MFA expects a corpus directory, dictionary, acoustic model, and output directory:

```fish
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba run -n mfa \
  mfa align \
  path/to/corpus \
  english_us_arpa \
  english_us_arpa \
  path/to/textgrids \
  --clean
```

For this project, prefer wrapping that command from uv-managed Python rather than importing MFA directly. Treat MFA as an external executable and keep all corpus preparation, filtering, metadata, and review logic in this uv project.

## Useful Checks

Check the uv project:

```fish
uv run python main.py
```

Check that MFA is callable:

```fish
env MAMBA_ROOT_PREFIX="$HOME/.local/share/micromamba" micromamba run -n mfa mfa version
```

If `micromamba run -n mfa ...` cannot find the environment, make sure `MAMBA_ROOT_PREFIX` is set to the same path used when creating it.
