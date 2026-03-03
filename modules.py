# Placeholder module definitions for CosmoSIS

AVAILABLE_MODULES = [
    {
        "id": "consistency",
        "name": "Consistency",
        "description": "Derive consistent cosmological parameters (e.g. omega_m from omega_b + omega_cdm)",
        "inputs": [
            {"name": "cosmological_parameters/omega_b", "type": "float", "description": "Baryon density"},
            {"name": "cosmological_parameters/omega_cdm", "type": "float", "description": "Cold dark matter density"},
        ],
        "outputs": [
            {"name": "cosmological_parameters/omega_m", "type": "float", "description": "Total matter density"},
            {"name": "cosmological_parameters/omega_lambda", "type": "float", "description": "Dark energy density"},
        ],
    },
    {
        "id": "boltzmann_camb",
        "name": "CAMB",
        "description": "Boltzmann code to compute CMB and matter power spectra",
        "inputs": [
            {"name": "cosmological_parameters/omega_b", "type": "float", "description": "Baryon density"},
            {"name": "cosmological_parameters/omega_cdm", "type": "float", "description": "Cold dark matter density"},
            {"name": "cosmological_parameters/h0", "type": "float", "description": "Hubble parameter"},
            {"name": "cosmological_parameters/n_s", "type": "float", "description": "Spectral index"},
            {"name": "cosmological_parameters/A_s", "type": "float", "description": "Scalar amplitude"},
        ],
        "outputs": [
            {"name": "cmb_cl/tt", "type": "array", "description": "CMB TT power spectrum"},
            {"name": "cmb_cl/ee", "type": "array", "description": "CMB EE power spectrum"},
            {"name": "cmb_cl/te", "type": "array", "description": "CMB TE cross-spectrum"},
            {"name": "matter_power_lin/p_k", "type": "array", "description": "Linear matter power spectrum"},
            {"name": "distances/d_l", "type": "array", "description": "Luminosity distances"},
        ],
    },
    {
        "id": "halofit",
        "name": "Halofit",
        "description": "Non-linear matter power spectrum using the Halofit fitting formula",
        "inputs": [
            {"name": "matter_power_lin/p_k", "type": "array", "description": "Linear matter power spectrum"},
            {"name": "cosmological_parameters/omega_m", "type": "float", "description": "Matter density"},
        ],
        "outputs": [
            {"name": "matter_power_nl/p_k", "type": "array", "description": "Non-linear matter power spectrum"},
        ],
    },
    {
        "id": "shear_cl",
        "name": "Shear Cl",
        "description": "Compute weak lensing shear angular power spectra",
        "inputs": [
            {"name": "matter_power_nl/p_k", "type": "array", "description": "Non-linear matter power spectrum"},
            {"name": "nz/bin_1", "type": "array", "description": "Galaxy n(z) bin 1"},
            {"name": "nz/bin_2", "type": "array", "description": "Galaxy n(z) bin 2"},
        ],
        "outputs": [
            {"name": "shear_cl/bin_1_1", "type": "array", "description": "Shear C_ℓ bin 1×1"},
            {"name": "shear_cl/bin_1_2", "type": "array", "description": "Shear C_ℓ bin 1×2"},
            {"name": "shear_cl/bin_2_2", "type": "array", "description": "Shear C_ℓ bin 2×2"},
        ],
    },
    {
        "id": "planck_likelihood",
        "name": "Planck",
        "description": "Planck 2018 CMB temperature and polarisation likelihood",
        "inputs": [
            {"name": "cmb_cl/tt", "type": "array", "description": "CMB TT power spectrum"},
            {"name": "cmb_cl/ee", "type": "array", "description": "CMB EE power spectrum"},
            {"name": "cmb_cl/te", "type": "array", "description": "CMB TE cross-spectrum"},
        ],
        "outputs": [
            {"name": "likelihoods/planck_like", "type": "float", "description": "Planck log-likelihood"},
        ],
    },
    {
        "id": "des_shear",
        "name": "DES Shear",
        "description": "DES Year 3 weak gravitational lensing likelihood",
        "inputs": [
            {"name": "shear_cl/bin_1_1", "type": "array", "description": "Shear C_ℓ bin 1×1"},
            {"name": "shear_cl/bin_1_2", "type": "array", "description": "Shear C_ℓ bin 1×2"},
            {"name": "shear_cl/bin_2_2", "type": "array", "description": "Shear C_ℓ bin 2×2"},
        ],
        "outputs": [
            {"name": "likelihoods/des_shear_like", "type": "float", "description": "DES shear log-likelihood"},
        ],
    },
    {
        "id": "distances",
        "name": "Distances",
        "description": "Compute cosmological distance measures",
        "inputs": [
            {"name": "cosmological_parameters/omega_m", "type": "float", "description": "Matter density"},
            {"name": "cosmological_parameters/omega_lambda", "type": "float", "description": "Dark energy density"},
            {"name": "cosmological_parameters/h0", "type": "float", "description": "Hubble parameter"},
        ],
        "outputs": [
            {"name": "distances/d_a", "type": "array", "description": "Angular diameter distances"},
            {"name": "distances/d_l", "type": "array", "description": "Luminosity distances"},
            {"name": "distances/d_c", "type": "array", "description": "Comoving distances"},
        ],
    },
]

# The Sampler is always the first module in the pipeline and cannot be removed.
SAMPLER_MODULE = {
    "id": "sampler",
    "name": "Sampler",
    "description": "Parameter sampler — draws samples from the cosmological parameter space",
    "permanent": True,
    "inputs": [],
    "outputs": [
        {"name": "cosmological_parameters/omega_b", "type": "float", "description": "Baryon density"},
        {"name": "cosmological_parameters/omega_cdm", "type": "float", "description": "Cold dark matter density"},
        {"name": "cosmological_parameters/h0", "type": "float", "description": "Hubble parameter"},
        {"name": "cosmological_parameters/n_s", "type": "float", "description": "Scalar spectral index"},
        {"name": "cosmological_parameters/A_s", "type": "float", "description": "Scalar amplitude"},
        {"name": "cosmological_parameters/sigma_8", "type": "float", "description": "Clustering amplitude σ₈"},
    ],
}


def get_available_modules():
    return AVAILABLE_MODULES


def get_initial_pipeline():
    return [SAMPLER_MODULE]
